#if os(macOS)
import Foundation
import Darwin
import CryptoKit

/// Preserves bound Info.plist, code-signature resources and executable together. No launch, signing or permission grant.
public struct NativeHelperApplication: Equatable, Sendable {
    public enum Kind: String, Sendable {
        case identity, cua
        public var applicationName: String { self == .identity ? "DexterDeviceIdentity.app" : "DexterControl.app" }
        public var executableName: String { self == .identity ? "dexter-device-identity" : "dexter-cua-helper" }
        public var bundleIdentifier: String { self == .identity ? "com.dexter.device-identity.helper" : "com.dexter.control.helper" }
    }
    public let bundle: URL
    public let kind: Kind
    public var executable: URL { bundle.appendingPathComponent("Contents/MacOS/"+kind.executableName) }
    public init(bundle:URL,kind:Kind) throws {
        self.bundle=bundle;self.kind=kind
        guard bundle.isFileURL,bundle.pathExtension=="app",LocalMacAgentSetup.canonical(bundle),LocalMacAgentSetup.realDirectories(bundle),
              LocalMacAgentSetup.validBrowserExecutable(executable) else { throw LocalMacAgentSetupError.helperNotPackaged }
        let info=try Self.sourceRead(bundle.appendingPathComponent("Contents/Info.plist"),maximum:16384)
        guard let object=try PropertyListSerialization.propertyList(from:info,format:nil) as? [String:Any],
              object["CFBundleIdentifier"] as? String==kind.bundleIdentifier,
              object["CFBundleExecutable"] as? String==kind.executableName,
              object["CFBundlePackageType"] as? String=="APPL" else { throw LocalMacAgentSetupError.helperNotPackaged }
        _=try snapshot()
    }
    struct File: Equatable, Sendable { let relative:String;let bytes:Data;let executable:Bool }
    struct Snapshot: Equatable, Sendable {
        let files:[File]
        var digest:Data {
            var hash=SHA256()
            for file in files { hash.update(data:Data(file.relative.utf8)+Data([0]));hash.update(data:Data(SHA256.hash(data:file.bytes))) }
            return Data(hash.finalize())
        }
    }
    func snapshot() throws -> Snapshot {
        var files:[File]=[],total=0
        func walk(_ dir:URL,_ relative:String,_ depth:Int)throws {
            guard depth<=8,LocalMacAgentSetup.canonical(dir),LocalMacAgentSetup.realDirectories(dir) else { throw LocalMacAgentSetupError.unsafeLocation }
            var st=stat();guard lstat(dir.path,&st)==0,st.st_mode&S_IFMT==S_IFDIR,st.st_mode&0o022==0,st.st_uid==getuid() || st.st_uid==0 else { throw LocalMacAgentSetupError.unsafeLocation }
            for name in try FileManager.default.contentsOfDirectory(atPath:dir.path).sorted() {
                guard name != ".",name != "..",!name.contains("\0") else { throw LocalMacAgentSetupError.unsafeLocation }
                let url=dir.appendingPathComponent(name),path=relative.isEmpty ? name : relative+"/"+name
                var entry=stat();guard lstat(url.path,&entry)==0 else { throw LocalMacAgentSetupError.unsafeLocation }
                if entry.st_mode&S_IFMT==S_IFDIR { try walk(url,path,depth+1) }
                else {
                    guard entry.st_mode&S_IFMT==S_IFREG,files.count<256 else { throw LocalMacAgentSetupError.unsafeLocation }
                    let isExecutable=path=="Contents/MacOS/"+kind.executableName
                    let data=try Self.sourceRead(url,maximum:64*1024*1024,executable:isExecutable)
                    total+=data.count;guard total<=128*1024*1024 else { throw LocalMacAgentSetupError.unsafeLocation }
                    files.append(File(relative:path,bytes:data,executable:isExecutable))
                }
            }
        }
        try walk(bundle,"",0)
        return Snapshot(files:files.sorted{$0.relative<$1.relative})
    }
    /// Public signed bundle files may be 644/755; private configuration rules do not apply to source code resources.
    private static func sourceRead(_ url:URL,maximum:Int,executable:Bool=false)throws->Data {
        guard LocalMacAgentSetup.canonical(url),LocalMacAgentSetup.realDirectories(url.deletingLastPathComponent()) else { throw LocalMacAgentSetupError.unsafeLocation }
        let fd=open(url.path,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);guard fd>=0 else { throw LocalMacAgentSetupError.unsafeLocation };defer{close(fd)}
        var before=stat(),after=stat()
        guard fstat(fd,&before)==0,before.st_mode&S_IFMT==S_IFREG,before.st_nlink==1,before.st_uid==getuid() || before.st_uid==0,
              before.st_mode&0o022==0,!executable || before.st_mode&0o111 != 0,before.st_size>0,before.st_size<=maximum else { throw LocalMacAgentSetupError.unsafeLocation }
        let data=try FileHandle(fileDescriptor:fd,closeOnDealloc:false).read(upToCount:maximum+1) ?? Data()
        guard data.count==before.st_size,fstat(fd,&after)==0,before.st_ino==after.st_ino,before.st_dev==after.st_dev,before.st_size==after.st_size,
              before.st_mtimespec.tv_sec==after.st_mtimespec.tv_sec,before.st_mtimespec.tv_nsec==after.st_mtimespec.tv_nsec else { throw LocalMacAgentSetupError.conflict }
        return data
    }
    /// Existing destinations refuse. A partial filesystem result is unknown; no Keychain item is touched.
    func stage(to target:URL) throws -> NativeHelperApplication {
        let original=try snapshot()
        guard target.lastPathComponent==kind.applicationName,LocalMacAgentSetup.canonical(target.deletingLastPathComponent()),
              LocalMacAgentSetup.realDirectories(target.deletingLastPathComponent()) else { throw LocalMacAgentSetupError.unsafeLocation }
        var parent=stat(),exists=stat()
        guard lstat(target.deletingLastPathComponent().path,&parent)==0,parent.st_uid==getuid(),parent.st_mode&0o777==0o700,
              lstat(target.path,&exists) != 0,errno==ENOENT,mkdir(target.path,0o700)==0 else { throw LocalMacAgentSetupError.conflict }
        for file in original.files {
            let destination=target.appendingPathComponent(file.relative)
            try FileManager.default.createDirectory(at:destination.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            guard LocalMacAgentSetup.canonical(destination.deletingLastPathComponent()),LocalMacAgentSetup.realDirectories(destination.deletingLastPathComponent()) else { throw LocalMacAgentSetupError.unsafeLocation }
            let fd=open(destination.path,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,file.executable ? 0o700 : 0o600)
            guard fd>=0 else { throw LocalMacAgentSetupError.writeFailed };defer{close(fd)}
            guard file.bytes.withUnsafeBytes({write(fd,$0.baseAddress,file.bytes.count)})==file.bytes.count,fsync(fd)==0 else { throw LocalMacAgentSetupError.writeFailed }
        }
        let staged=try NativeHelperApplication(bundle:target,kind:kind)
        guard try snapshot()==original,try staged.snapshot()==original else { throw LocalMacAgentSetupError.conflict }
        return staged
    }
}
#endif
