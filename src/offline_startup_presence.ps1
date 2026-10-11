param([Parameter(Mandatory=$true)][string]$TaskName)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$state = 'unverifiable'
$service = $null
$folder = $null
$task = $null
try {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $folder = $service.GetFolder('\')
    try {
        $task = $folder.GetTask($TaskName)
        if ($null -ne $task) { $state = 'present' }
    } catch {
        # Only a typed COM file-not-found result from GetTask proves absence.
        # HRESULTs from connection/root-folder failures never enter this branch.
        $exception = $_.Exception
        for ($depth = 0; $depth -lt 8 -and $null -ne $exception; $depth++) {
            if ($exception -is [System.Runtime.InteropServices.COMException]) {
                if ($exception.HResult -eq -2147024894) { $state = 'absent' }
                break
            }
            $exception = $exception.InnerException
        }
    }
} catch { $state = 'unverifiable' }
finally {
    foreach ($owned in @($task,$folder,$service)) {
        if ($null -ne $owned -and [System.Runtime.InteropServices.Marshal]::IsComObject($owned)) {
            try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($owned) }
            catch { $state = 'unverifiable' }
        }
    }
}
[Console]::Out.Write('{"schema":"uci_arena_evidence_startup_presence_v1","state":"' + $state + '"}')
