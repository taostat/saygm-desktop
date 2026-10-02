param(
  [Parameter(Mandatory = $true)]
  [string]$ReportPath
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class SayGmDpapiProbe
{
    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int Length;
        public IntPtr Data;
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(
        ref DataBlob input,
        string description,
        IntPtr entropy,
        IntPtr reserved,
        IntPtr prompt,
        uint flags,
        out DataBlob output);

    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(
        ref DataBlob input,
        IntPtr description,
        IntPtr entropy,
        IntPtr reserved,
        IntPtr prompt,
        uint flags,
        out DataBlob output);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    private static DataBlob ToBlob(byte[] value, out IntPtr allocation)
    {
        allocation = Marshal.AllocHGlobal(value.Length);
        Marshal.Copy(value, 0, allocation, value.Length);
        return new DataBlob { Length = value.Length, Data = allocation };
    }

    private static byte[] CopyAndFree(DataBlob value)
    {
        try
        {
            var result = new byte[value.Length];
            Marshal.Copy(value.Data, result, 0, value.Length);
            return result;
        }
        finally
        {
            if (value.Data != IntPtr.Zero) LocalFree(value.Data);
        }
    }

    public static byte[] Protect(byte[] value)
    {
        IntPtr allocation;
        var input = ToBlob(value, out allocation);
        try
        {
            DataBlob output;
            if (!CryptProtectData(ref input, "SayGM disposable CI probe", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return CopyAndFree(output);
        }
        finally
        {
            Marshal.FreeHGlobal(allocation);
        }
    }

    public static byte[] Unprotect(byte[] value)
    {
        IntPtr allocation;
        var input = ToBlob(value, out allocation);
        try
        {
            DataBlob output;
            if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return CopyAndFree(output);
        }
        finally
        {
            Marshal.FreeHGlobal(allocation);
        }
    }
}
"@

$plain = [System.Text.Encoding]::UTF8.GetBytes("saygm-windows-ci-dpapi-probe")
$encrypted = [SayGmDpapiProbe]::Protect($plain)
$roundTrip = [SayGmDpapiProbe]::Unprotect($encrypted)
if (-not [System.Linq.Enumerable]::SequenceEqual([byte[]]$plain, [byte[]]$roundTrip)) {
  throw "Windows DPAPI ProtectData/UnprotectData round trip changed the disposable probe bytes."
}

$sha = [System.Security.Cryptography.SHA256]::HashData($plain)
$report = [ordered]@{
  platform = "windows"
  api = "CryptProtectData/CryptUnprotectData"
  protection_scope = "current-user"
  disposable_probe_bytes = $plain.Length
  disposable_probe_sha256 = [Convert]::ToHexString($sha).ToLowerInvariant()
  encrypted_bytes = $encrypted.Length
  round_trip = $true
}
$json = $report | ConvertTo-Json -Depth 3
$parent = Split-Path -Parent $ReportPath
New-Item -ItemType Directory -Path $parent -Force | Out-Null
[System.IO.File]::WriteAllText($ReportPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Output $json
