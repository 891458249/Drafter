param([string]$Directory)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DebugJob {
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFO { public int cb; public IntPtr reserved, desktop, title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint count; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref EXTENDED_LIMIT info,uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] public static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,IntPtr data,uint size,IntPtr length);
  static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  public static IntPtr Create() {
    var job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
    var info=new EXTENDED_LIMIT(); info.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway
    try { Check(SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf(info))); return job; }
    catch { CloseHandle(job); throw; }
  }
  public static uint Start(IntPtr job,string app,string command,string cwd) {
    var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(si); PROCESS_INFORMATION pi;
    Check(CreateProcess(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x00000004|0x00000400,IntPtr.Zero,cwd,ref si,out pi));
    try { Check(AssignProcessToJobObject(job,pi.process)); Check(ResumeThread(pi.thread)!=0xffffffff); return pi.pid; }
    catch { TerminateProcess(pi.process,1); throw; }
    finally { CloseHandle(pi.thread); CloseHandle(pi.process); }
  }
  public static uint[] Members(IntPtr job) {
    int size=65536; IntPtr mem=Marshal.AllocHGlobal(size);
    try {
      Check(QueryInformationJobObject(job,3,mem,(uint)size,IntPtr.Zero));
      int count=Marshal.ReadInt32(mem,4); if(count<0 || count>(size-8)/IntPtr.Size) throw new Exception("Job member list overflow");
      var result=new uint[count]; for(int i=0;i<count;i++) result[i]=(uint)Marshal.ReadIntPtr(mem,8+i*IntPtr.Size).ToInt64(); return result;
    } finally { Marshal.FreeHGlobal(mem); }
  }
}
'@
function Save-State($state) {
  $json = $state | ConvertTo-Json -Depth 8 -Compress
  $temp = Join-Path $Directory 'state.tmp'
  [IO.File]::WriteAllText($temp, $json, (New-Object Text.UTF8Encoding($false)))
  $target = Join-Path $Directory 'state.json'
  if ([IO.File]::Exists($target)) { [IO.File]::Replace($temp, $target, ($target + '.bak')) } else { [IO.File]::Move($temp, $target) }
}
function Identity($id) {
  try { $p = [Diagnostics.Process]::GetProcessById($id); return $p.StartTime.ToUniversalTime().Ticks.ToString() } catch { return $null }
}
$job = [IntPtr]::Zero
$state = $null
try {
  $spec = [Console]::In.ReadLine() | ConvertFrom-Json
  if (-not $spec.exe -or -not $spec.ownerPid -or -not $spec.ownerStarted) { throw 'Missing executable or owner identity' }
  if ((Identity $spec.ownerPid) -ne $spec.ownerStarted) { throw 'Debug owner has already exited or changed identity' }
  if ($spec.env) { foreach ($entry in $spec.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process') } }
  $job = [DebugJob]::Create()
  $childId = [DebugJob]::Start($job, $spec.exe, $spec.command, $spec.cwd)
  $state = @{ version=1; id=$spec.id; scope=$spec.scope; status='running'; pid=$childId; started=(Identity $childId); exe=$spec.exe; supervisorPid=$PID; supervisorStarted=(Identity $PID); ownerPid=$spec.ownerPid; ownerStarted=$spec.ownerStarted; ports=@($spec.ports); error=$null }
  Save-State $state
  [Console]::Out.WriteLine('ready')
  $stopFile = Join-Path $Directory 'stop'
  while (([DebugJob]::Members($job)).Count -gt 0) {
    if ([IO.File]::Exists($stopFile) -or (Identity $spec.ownerPid) -ne $spec.ownerStarted) { break }
    Start-Sleep -Milliseconds 200
  }
  # Only processes in this private Job may receive a normal close request.
  foreach ($member in [DebugJob]::Members($job)) {
    try { $p=[Diagnostics.Process]::GetProcessById($member); [void]$p.CloseMainWindow() } catch {}
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(2)
  while (([DebugJob]::Members($job)).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
  if (([DebugJob]::Members($job)).Count -gt 0) {
    if (-not [DebugJob]::TerminateJobObject($job, 1)) { throw 'TerminateJobObject failed' }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while (([DebugJob]::Members($job)).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
  if (([DebugJob]::Members($job)).Count -ne 0) { throw 'Debug Job still contains active processes' }
  $state.status = 'released'
  Save-State $state
} catch {
  if ($state) { $state.status='failed'; $state.error=$_.Exception.Message; Save-State $state }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($job -ne [IntPtr]::Zero) { [void][DebugJob]::CloseHandle($job) }
}
