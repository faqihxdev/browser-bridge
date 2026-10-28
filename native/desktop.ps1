$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BridgeInput {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEYBOARD keyboard; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBOARD { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
  public static void Click(bool right) {
    INPUT[] inputs = new INPUT[2];
    inputs[0].data.mouse.flags = right ? 8u : 2u;
    inputs[1].data.mouse.flags = right ? 16u : 4u;
    if(SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new Exception("Windows rejected the mouse input.");
  }
}
'@
$script:refs = @{}
$script:generation = 0
function Find-Element($request) {
  if ($request.ref) {
    if (-not $script:refs.ContainsKey([string]$request.ref)) { throw 'Stale desktop reference. Inspect the window again.' }
    return $script:refs[[string]$request.ref]
  }
  if ($request.hwnd) { return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$request.hwnd) }
  if ($request.pid) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$request.pid)
    $found = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
    if (-not $found) { throw 'No window for that process.' }; return $found
  }
  return [System.Windows.Automation.AutomationElement]::RootElement
}
function Summarize-Element($element, $depth) {
  $current = $element.Current
  $rect = $current.BoundingRectangle
  $id = "d$script:generation-$($script:refs.Count + 1)"
  $script:refs[$id] = $element
  return [ordered]@{ ref=$id; depth=$depth; name=$current.Name; type=$current.ControlType.ProgrammaticName; automationId=$current.AutomationId; pid=$current.ProcessId; hwnd=$current.NativeWindowHandle; enabled=$current.IsEnabled; rect=@{ x=$rect.X; y=$rect.Y; width=$rect.Width; height=$rect.Height } }
}
function Focus-Window($element) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $window = $element
  while ($window.Current.NativeWindowHandle -eq 0 -or $window.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
    $parent = $walker.GetParent($window); if (-not $parent) { break }; $window = $parent
  }
  $handle = [IntPtr]$window.Current.NativeWindowHandle
  if ($handle -eq [IntPtr]::Zero) { throw 'No native window handle.' }
  [void][BridgeInput]::ShowWindow($handle, 9)
  [void][BridgeInput]::SetForegroundWindow($handle)
  if ([BridgeInput]::GetForegroundWindow() -ne $handle) { throw 'The target window could not receive foreground input.' }
}
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    $result = $null
    if ($request.action -eq 'windows') {
      $script:refs = @{}; $script:generation++
      $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      $result = @($windows | ForEach-Object { Summarize-Element $_ 0 })
    } elseif ($request.action -eq 'inspect') {
      $root = Find-Element $request
      $script:refs = @{}; $script:generation++
      $maxDepth = 4; if ($null -ne $request.maxDepth) { $maxDepth = [Math]::Min(12, [int]$request.maxDepth) }
      $maxNodes = 200; if ($request.maxNodes) { $maxNodes = [Math]::Min(2000, [int]$request.maxNodes) }
      $queue = New-Object System.Collections.Queue
      $queue.Enqueue(@{ element=$root; depth=0 })
      $items = New-Object System.Collections.Generic.List[object]
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      while ($queue.Count -gt 0 -and $items.Count -lt $maxNodes) {
        $item = $queue.Dequeue()
        try {
          $items.Add((Summarize-Element $item.element $item.depth))
          if ($item.depth -lt $maxDepth) {
            $child = $walker.GetFirstChild($item.element)
            while ($null -ne $child -and $queue.Count -lt $maxNodes) { $queue.Enqueue(@{ element=$child; depth=$item.depth+1 }); $child = $walker.GetNextSibling($child) }
          }
        } catch { }
      }
      $result = @{ elements=@($items.ToArray()); truncated=($queue.Count -gt 0) }
    } elseif ($request.action -eq 'cursor') {
      if ($null -eq $request.x -or $null -eq $request.y) { throw 'Provide x and y.' }
      [void][BridgeInput]::SetCursorPos([int]$request.x, [int]$request.y); $result = $true
    } else {
      if (-not $request.ref -and -not $request.hwnd -and -not $request.pid) { throw 'Provide ref, hwnd or pid to target a native window.' }
      $element = Find-Element $request
      switch ($request.action) {
        'invoke' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $pattern.Invoke(); $result=$true }
        'value' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $pattern.SetValue([string]$request.text); $result=$true }
        'toggle' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $pattern.Toggle(); $result=$true }
        'expand' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); $pattern.Expand(); $result=$true }
        'collapse' { $pattern = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); $pattern.Collapse(); $result=$true }
        'focus' { Focus-Window $element; $result=$true }
        'keys' { Focus-Window $element; [System.Windows.Forms.SendKeys]::SendWait([string]$request.keys); $result=$true }
        'click' {
          Focus-Window $element
          $rect = $element.Current.BoundingRectangle
          $x=$rect.X+$rect.Width/2; $y=$rect.Y+$rect.Height/2
          if ($null -ne $request.x) { $x=[double]$request.x }; if ($null -ne $request.y) { $y=[double]$request.y }
          [void][BridgeInput]::SetCursorPos([int]$x, [int]$y); [BridgeInput]::Click($request.button -eq 'right'); $result=$true
        }
        'screenshot' {
          Focus-Window $element; $rect=$element.Current.BoundingRectangle
          $bitmap=New-Object System.Drawing.Bitmap([int]$rect.Width,[int]$rect.Height)
          $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
          $stream=New-Object System.IO.MemoryStream
          try { $graphics.CopyFromScreen([int]$rect.X,[int]$rect.Y,0,0,$bitmap.Size); $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png); $result=@{mimeType='image/png';data=[Convert]::ToBase64String($stream.ToArray())} }
          finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
        }
        default { throw 'Unknown desktop action. Use windows, inspect, invoke, value, toggle, expand, collapse, focus, keys, click, cursor or screenshot.' }
      }
    }
    [Console]::WriteLine((@{ id=$request.id; result=$result } | ConvertTo-Json -Compress -Depth 18))
  } catch { [Console]::WriteLine((@{ id=$request.id; error=$_.Exception.Message } | ConvertTo-Json -Compress -Depth 5)) }
}
