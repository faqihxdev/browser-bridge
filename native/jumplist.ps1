$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$settings = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("6332DEBF-87B5-4670-90C0-5E57B408A49E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDestinationList {
 void SetAppID([MarshalAs(UnmanagedType.LPWStr)] string id);
 void BeginList(out uint slots, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object removed);
 void AppendCategory([MarshalAs(UnmanagedType.LPWStr)] string name, IObjectArray items);
 void AppendKnownCategory(int category);
 void AddUserTasks(IObjectArray tasks);
 void CommitList();
 void GetRemovedDestinations(ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object removed);
 void DeleteList([MarshalAs(UnmanagedType.LPWStr)] string id);
 void AbortList();
}
[ComImport, Guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IObjectArray {
 void GetCount(out uint count);
 void GetAt(uint index, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object item);
}
[ComImport, Guid("5632B1A4-E38A-400A-928A-D4CD63230295"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IObjectCollection {
 void GetCount(out uint count);
 void GetAt(uint index, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object item);
 void AddObject([MarshalAs(UnmanagedType.IUnknown)] object item);
 void AddFromArray(IObjectArray items);
 void RemoveObjectAt(uint index);
 void Clear();
}
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellLink {
 void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
 void GetIDList(out IntPtr list);
 void SetIDList(IntPtr list);
 void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count);
 void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
 void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count);
 void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
 void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int count);
 void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
 void GetHotkey(out short key);
 void SetHotkey(short key);
 void GetShowCmd(out int command);
 void SetShowCmd(int command);
 void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index);
 void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
 void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
 void Resolve(IntPtr window, uint flags);
 void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
}
[StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid format; public uint id; }
[StructLayout(LayoutKind.Explicit, Size=24)] struct PropertyValue {
 [FieldOffset(0)] public ushort type;
 [FieldOffset(8)] public IntPtr text;
}
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
 void GetCount(out uint count);
 void GetAt(uint index, out PropertyKey key);
 void GetValue(ref PropertyKey key, out PropertyValue value);
 void SetValue(ref PropertyKey key, ref PropertyValue value);
 void Commit();
}
public static class BridgeJumpList {
 static object Create(string id) { return Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(id))); }
 public static void Publish(string appId, string executable, string normal, string incognito) {
  object destination = Create("77F10CF0-3DB5-4966-B520-B7C54FD35ED6");
  object collection = Create("2D3468C1-36A7-43B6-AC24-D3F02FD9607A");
  object removed = null;
  bool begun = false;
  try {
   var list = (IDestinationList)destination;
   list.SetAppID(appId);
   Guid iid = typeof(IObjectArray).GUID;
   uint slots;
   list.BeginList(out slots, ref iid, out removed);
   begun = true;
   string[] titles = { "New window", "New private window" };
   string[] arguments = { normal, incognito };
   for (int i=0; i<2; i++) {
    object item = Create("00021401-0000-0000-C000-000000000046");
    try {
     var link = (IShellLink)item;
     link.SetPath(executable);
     link.SetArguments(arguments[i]);
     link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(executable));
     link.SetIconLocation(executable, i == 0 ? 0 : 2);
     var key = new PropertyKey { format = new Guid("F29F85E0-4FF9-1068-AB91-08002B27B3D9"), id = 2 };
     var value = new PropertyValue { type = 31, text = Marshal.StringToCoTaskMemUni(titles[i]) };
     try { ((IPropertyStore)item).SetValue(ref key, ref value); }
     finally { Marshal.FreeCoTaskMem(value.text); }
     ((IPropertyStore)item).Commit();
     ((IObjectCollection)collection).AddObject(item);
    } finally { Marshal.ReleaseComObject(item); }
   }
   list.AddUserTasks((IObjectArray)collection);
   list.CommitList();
   begun = false;
  } finally {
   if (begun) ((IDestinationList)destination).AbortList();
   if (removed != null) Marshal.ReleaseComObject(removed);
   Marshal.ReleaseComObject(collection);
   Marshal.ReleaseComObject(destination);
  }
 }
}
'@
[BridgeJumpList]::Publish($settings.appId, $settings.executable, $settings.tasks[0], $settings.tasks[1])
