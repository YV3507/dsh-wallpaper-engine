#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WE 只读探针 (阶段 1): 验证"零注入、零写入"的外部内存读取通路。

约束 (用户要求, 历史上 hook 曾损坏 WE):
  * 只用 OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ) + ReadProcessMemory;
  * 绝不调用 WriteProcessMemory / VirtualAllocEx / CreateRemoteThread / SetWindowsHookEx;
  * 不改 WE 安装目录任何文件; 不附加调试器 (阶段 2 才考虑 cdb -pv)。

阶段 1 目标: 枚举 wallpaper64.exe → 打开只读句柄 → 枚举模块拿基址 → 读 PE 头,
证明通路可用 (真正的 +0x304 / 骨骼矩阵采样放在阶段 2, 需要实例指针)。
"""
import ctypes
import ctypes.wintypes as wt
import sys

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
TH32CS_SNAPPROCESS = 0x00000002
TH32CS_SNAPMODULE = 0x00000008
TH32CS_SNAPMODULE32 = 0x00000010
MAX_PATH = 260
LIST_MODULES_ALL = 0x03

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
psapi = ctypes.WinDLL('psapi', use_last_error=True)
# 显式声明原型: 避免 64 位 HMODULE/句柄被当成 int 溢出 (argument 2: OverflowError)
psapi.EnumProcessModulesEx.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD,
                                       ctypes.POINTER(wt.DWORD), wt.DWORD]
psapi.EnumProcessModulesEx.restype = wt.BOOL
psapi.GetModuleBaseNameW.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_wchar_p, wt.DWORD]
psapi.GetModuleBaseNameW.restype = wt.DWORD


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ('dwSize', wt.DWORD), ('cntUsage', wt.DWORD), ('th32ProcessID', wt.DWORD),
        ('th32DefaultHeapID', ctypes.POINTER(ctypes.c_ulong)), ('th32ModuleID', wt.DWORD),
        ('cntThreads', wt.DWORD), ('th32ParentProcessID', wt.DWORD),
        ('pcPriClassBase', ctypes.c_long), ('dwFlags', wt.DWORD),
        ('szExeFile', ctypes.c_char * MAX_PATH),
    ]


class MODULEENTRY32(ctypes.Structure):
    _fields_ = [
        ('dwSize', wt.DWORD), ('th32ModuleID', wt.DWORD), ('th32ProcessID', wt.DWORD),
        ('GlblcntUsage', wt.DWORD), ('ProccntUsage', wt.DWORD),
        ('modBaseAddr', ctypes.POINTER(ctypes.c_byte)), ('modBaseSize', wt.DWORD),
        ('hModule', wt.HMODULE), ('szModule', ctypes.c_char * 256),
        ('szExePath', ctypes.c_char * MAX_PATH),
    ]


def find_pids(name):
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        raise OSError('CreateToolhelp32Snapshot failed: %d' % ctypes.get_last_error())
    out = []
    try:
        e = PROCESSENTRY32()
        e.dwSize = ctypes.sizeof(PROCESSENTRY32)
        ok = k32.Process32First(snap, ctypes.byref(e))
        while ok:
            exe = e.szExeFile.decode('mbcs', 'ignore')
            if exe.lower() == name.lower():
                out.append((e.th32ProcessID, exe))
            ok = k32.Process32Next(snap, ctypes.byref(e))
    finally:
        k32.CloseHandle(snap)
    return out


def modules(h, pid):
    """用只读句柄枚举模块 (EnumProcessModulesEx) —— 比 Toolhelp 快照更适合跨进程只读。"""
    arr = (wt.HMODULE * 2048)()
    needed = wt.DWORD(0)
    ok = psapi.EnumProcessModulesEx(h, ctypes.byref(arr), ctypes.sizeof(arr),
                                    ctypes.byref(needed), LIST_MODULES_ALL)
    if not ok:
        return []
    n = needed.value // ctypes.sizeof(wt.HMODULE)
    out = []
    namebuf = ctypes.create_unicode_buffer(MAX_PATH)
    for i in range(n):
        hm = arr[i]
        base = ctypes.cast(hm, ctypes.c_void_p).value or 0
        nm = namebuf.value if psapi.GetModuleBaseNameW(h, ctypes.c_void_p(base), namebuf, MAX_PATH) else '?'
        out.append((nm, base, 0))
    return out


def read_mem(h, addr, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size, ctypes.byref(got))
    if not ok:
        return None, ctypes.get_last_error()
    return buf.raw[:got.value], 0


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else 'wallpaper64.exe'
    pids = find_pids(target)
    print('[probe] 目标进程 %s → %d 个实例: %s' % (target, len(pids), [p for p, _ in pids]))
    if not pids:
        print('[probe] 未找到进程 (WE 未在运行或壁纸非 scene 类型)')
        return 0
    pid = pids[0][0]
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        print('[probe] OpenProcess(只读) 失败 err=%d' % ctypes.get_last_error())
        return 1
    print('[probe] [ok] OpenProcess 只读句柄 ok (pid=%d, flags=QUERY_INFORMATION|VM_READ)' % pid)
    try:
        mods = modules(h, pid)
        print('[probe] 模块数=%d' % len(mods))
        main_mod = None
        for name, base, size in mods:
            if name.lower() == target.lower():
                main_mod = (name, base, size)
            if name.lower() in ('d3d11.dll', 'dxgi.dll', 'nvwgf2umx.dll', 'igdgmm64.dll', 'igc64.dll'):
                print('    [gpu] %s base=0x%X size=0x%X' % (name, base, size))
        if not main_mod:
            print('[probe] 未在模块列表找到主模块')
            return 1
        name, base, size = main_mod
        print('[probe] 主模块 %s base=0x%X size=0x%X (≈%.1f MB)' % (name, base, size, size / 1048576))
        data, err = read_mem(h, base, 0x400)
        if data is None:
            print('[probe] ReadProcessMemory 失败 err=%d' % err)
            return 1
        mz = data[0:2]
        pe_off = int.from_bytes(data[0x3C:0x40], 'little')
        sig = b''
        if pe_off + 4 <= len(data):
            sig = data[pe_off:pe_off + 4]
        print('[probe] [ok] 只读读取 ok: MZ=%r PE@0x%X sig=%r' % (mz, pe_off, sig))
        # 验证可读的固定偏移 (wallpaper64.exe 里 autosize 标志位所用的 +0x304 偏移量级)
        probe2, err2 = read_mem(h, base + 0x304, 4)
        if probe2 is not None:
            print('[probe] [ok] 模块内 +0x304 可读 (样例字节 %r — 说明按偏移采样通路可用)' % probe2)
    finally:
        k32.CloseHandle(h)
    print('[probe] 全程只读, 未写入任何字节。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
