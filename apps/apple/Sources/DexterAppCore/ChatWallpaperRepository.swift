#if os(macOS)
import Foundation
import CryptoKit
import Darwin
import ImageIO
import UniformTypeIdentifiers

public enum ChatWallpaperError: Error, Equatable, Sendable {
    case invalidImage, imageTooLarge, privateCopyUnavailable
}

public struct PreparedChatWallpaper: Sendable {
    public let jpeg: Data
    public let width: Int
    public let height: Int
    fileprivate init(jpeg: Data, width: Int, height: Int) { self.jpeg = jpeg; self.width = width; self.height = height }
}

/// A bounded re-encoded private app copy; no bookmarks or subsequent access to the original photo.
public struct ChatWallpaperRepository: Sendable {
    public let root: URL
    public init(root: URL) { self.root = root }
    public static let inputLimit = 20 * 1024 * 1024

    public static func prepare(file: URL) throws -> PreparedChatWallpaper {
        let scoped = file.startAccessingSecurityScopedResource()
        defer { if scoped { file.stopAccessingSecurityScopedResource() } }
        guard file.isFileURL else { throw ChatWallpaperError.invalidImage }
        // A named pipe, device or linked file must not block a detached import indefinitely.
        let fd = open(file.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw ChatWallpaperError.invalidImage }
        defer { close(fd) }
        var state = stat()
        guard fstat(fd, &state) == 0, (state.st_mode & S_IFMT) == S_IFREG, state.st_size >= 0
        else { throw ChatWallpaperError.invalidImage }
        guard state.st_size <= inputLimit else { throw ChatWallpaperError.imageTooLarge }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while data.count <= inputLimit {
            try Task.checkCancellation()
            let n = read(fd, &buffer, min(buffer.count, inputLimit + 1 - data.count))
            if n < 0, errno == EINTR { continue }
            guard n >= 0 else { throw ChatWallpaperError.invalidImage }
            if n == 0 { break }
            data.append(contentsOf: buffer.prefix(n))
        }
        return try prepare(data: data)
    }

    public static func prepare(data: Data) throws -> PreparedChatWallpaper {
        try Task.checkCancellation()
        guard data.count <= inputLimit else { throw ChatWallpaperError.imageTooLarge }
        guard !data.isEmpty,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) == 1,
              let type = CGImageSourceGetType(source) as String?,
              [UTType.jpeg.identifier, UTType.png.identifier, UTType.heic.identifier, "public.heif"].contains(type),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0,
              width <= 50_000_000 / height else { throw ChatWallpaperError.invalidImage }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 4096, kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true]
        try Task.checkCancellation()
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: thumbnail.width, height: thumbnail.height,
                bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { throw ChatWallpaperError.invalidImage }
        context.setFillColor(CGColor(gray: 0.12, alpha: 1))
        let bounds = CGRect(x: 0, y: 0, width: thumbnail.width, height: thumbnail.height)
        context.fill(bounds); context.draw(thumbnail, in: bounds)
        guard let flattened = context.makeImage() else { throw ChatWallpaperError.invalidImage }
        try Task.checkCancellation()
        let encoded = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(encoded, UTType.jpeg.identifier as CFString, 1, nil)
        else { throw ChatWallpaperError.invalidImage }
        // Only pixels are copied. EXIF/GPS, original names, metadata and animation never reach the private copy.
        CGImageDestinationAddImage(destination, flattened, [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
        guard CGImageDestinationFinalize(destination), encoded.length > 0, encoded.length <= 16_777_216
        else { throw ChatWallpaperError.imageTooLarge }
        return PreparedChatWallpaper(jpeg: encoded as Data, width: flattened.width, height: flattened.height)
    }

    public func store(_ prepared: PreparedChatWallpaper) throws -> ChatWallpaperReference {
        let reference = ChatWallpaperReference(id: UUID(), sha256: Self.digest(prepared.jpeg),
            width: prepared.width, height: prepared.height, byteCount: prepared.jpeg.count)
        guard reference.isValid else { throw ChatWallpaperError.invalidImage }
        let directory = try openRoot(create: true); defer { close(directory) }
        let fd = openat(directory, reference.filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ChatWallpaperError.privateCopyUnavailable }
        var committed = false
        defer { close(fd); if !committed { unlinkat(directory, reference.filename, 0) } }
        let complete = prepared.jpeg.withUnsafeBytes { bytes -> Bool in
            guard let base = bytes.baseAddress else { return false }
            var written = 0
            while written < bytes.count {
                let n = write(fd, base.advanced(by: written), bytes.count - written)
                if n < 0, errno == EINTR { continue }
                guard n > 0 else { return false }; written += n
            }
            return true
        }
        guard complete, fsync(fd) == 0, fsync(directory) == 0 else { throw ChatWallpaperError.privateCopyUnavailable }
        committed = true; return reference
    }

    public func load(_ reference: ChatWallpaperReference) throws -> Data {
        guard reference.isValid else { throw ChatWallpaperError.privateCopyUnavailable }
        let directory = try openRoot(create: false); defer { close(directory) }
        let fd = openat(directory, reference.filename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw ChatWallpaperError.privateCopyUnavailable }
        defer { close(fd) }
        return try verifiedData(reference, fd: fd).data
    }

    private func verifiedData(_ reference: ChatWallpaperReference, fd: Int32) throws -> (data: Data, state: stat) {
        var state = stat()
        guard fstat(fd, &state) == 0, (state.st_mode & S_IFMT) == S_IFREG, state.st_uid == getuid(),
              state.st_nlink == 1, (state.st_mode & 0o777) == 0o600, state.st_size == reference.byteCount
        else { throw ChatWallpaperError.privateCopyUnavailable }
        var data = Data(count: reference.byteCount)
        let complete = data.withUnsafeMutableBytes { bytes -> Bool in
            guard let base = bytes.baseAddress else { return false }
            var offset = 0
            while offset < bytes.count {
                let n = read(fd, base.advanced(by: offset), bytes.count - offset)
                if n < 0, errno == EINTR { continue }
                guard n > 0 else { return false }; offset += n
            }
            return true
        }
        guard complete, Self.digest(data) == reference.sha256 else { throw ChatWallpaperError.privateCopyUnavailable }
        return (data, state)
    }

    /// Removes only the app's own verified copy. The original selected photo is never changed.
    public func remove(_ reference: ChatWallpaperReference) throws {
        guard reference.isValid else { throw ChatWallpaperError.privateCopyUnavailable }
        let directory = try openRoot(create: false); defer { close(directory) }
        let fd = openat(directory, reference.filename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw ChatWallpaperError.privateCopyUnavailable }
        defer { close(fd) }
        let verified = try verifiedData(reference, fd: fd).state
        var current = stat()
        guard fstatat(directory, reference.filename, &current, AT_SYMLINK_NOFOLLOW) == 0,
              current.st_dev == verified.st_dev, current.st_ino == verified.st_ino,
              current.st_uid == verified.st_uid, current.st_mode == verified.st_mode,
              current.st_nlink == verified.st_nlink, current.st_size == verified.st_size,
              current.st_mtimespec.tv_sec == verified.st_mtimespec.tv_sec,
              current.st_mtimespec.tv_nsec == verified.st_mtimespec.tv_nsec
        else { throw ChatWallpaperError.privateCopyUnavailable }
        // Same-directory descriptor prevents a replaced root from redirecting removal. Like all app-local files,
        // this is an ownership/consistency guard, not isolation from arbitrary software running as the same user.
        guard unlinkat(directory, reference.filename, 0) == 0, fsync(directory) == 0
        else { throw ChatWallpaperError.privateCopyUnavailable }
    }

    private func openRoot(create: Bool) throws -> Int32 {
        guard root.isFileURL, root.path.hasPrefix("/"), root.standardizedFileURL.path == root.path
        else { throw ChatWallpaperError.privateCopyUnavailable }
        var existing = root
        while !FileManager.default.fileExists(atPath: existing.path), existing.path != "/" {
            var st = stat()
            guard lstat(existing.path, &st) != 0, errno == ENOENT else { throw ChatWallpaperError.privateCopyUnavailable }
            existing.deleteLastPathComponent()
        }
        var ancestor = existing
        while ancestor.path != "/" {
            var st = stat()
            guard lstat(ancestor.path, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR,
                  st.st_uid == getuid() || st.st_uid == 0, (st.st_mode & 0o022) == 0
            else { throw ChatWallpaperError.privateCopyUnavailable }
            ancestor.deleteLastPathComponent()
        }
        if create, existing != root {
            do { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]) } catch { throw ChatWallpaperError.privateCopyUnavailable }
        }
        let fd = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw ChatWallpaperError.privateCopyUnavailable }
        var state = stat()
        guard fstat(fd, &state) == 0, state.st_uid == getuid(), (state.st_mode & 0o777) == 0o700
        else { close(fd); throw ChatWallpaperError.privateCopyUnavailable }
        return fd
    }
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
#endif
