import Foundation

public enum NativeActionError: Error, Equatable, Sendable {
    case invalidArguments
    case invalidThreadID
    case invalidDraft
    case handoffQueueFull
}

/// Host-issued thread ID. It identifies a destination; it grants no access or host authority.
public struct DexterThreadID: Hashable, Sendable, CustomStringConvertible {
    public let rawValue: String

    public init(_ value: String) throws {
        guard Self.isCanonical(value) else { throw NativeActionError.invalidThreadID }
        rawValue = value
    }

    public var description: String { rawValue }

    private static func isCanonical(_ value: String) -> Bool {
        guard value.hasPrefix("thr_") else { return false }
        let parts = value.dropFirst(4).split(separator: "-", omittingEmptySubsequences: false)
        guard parts.map(\.count) == [8, 4, 4, 4, 12] else { return false }
        return parts.allSatisfy { part in part.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
    }
}

/// A draft is kept only in the transient handoff. Its diagnostic representation never includes text.
public struct BoundedDraft: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public static let maximumUTF16Length = 4_096
    public let text: String

    public init(_ text: String) throws {
        guard text.utf16.count <= Self.maximumUTF16Length else { throw NativeActionError.invalidDraft }

        let normalized = text.precomposedStringWithCanonicalMapping
        guard normalized.utf16.count <= Self.maximumUTF16Length,
              !normalized.unicodeScalars.contains(where: Self.isForbiddenScalar),
              normalized.unicodeScalars.contains(where: Self.isVisibleScalar) else {
            throw NativeActionError.invalidDraft
        }
        self.text = normalized
    }

    public var description: String { "<redacted draft>" }
    public var debugDescription: String { "BoundedDraft(<redacted>)" }

    public var customMirror: Mirror {
        Mirror(self, children: [("text", "<redacted>")], displayStyle: .struct)
    }

    private static func isForbiddenScalar(_ scalar: Unicode.Scalar) -> Bool {
        let value = scalar.value
        if value < 0x20 {
            return value != 0x09 && value != 0x0A && value != 0x0D
        }
        if (0x7F...0x9F).contains(value) || value == 0x2028 || value == 0x2029 || value == 0xFEFF || value == 0x200B {
            return true
        }
        if value == 0x061C || value == 0x200E || value == 0x200F
            || (0x202A...0x202E).contains(value)
            || (0x2066...0x2069).contains(value) {
            return true
        }
        if scalar.properties.generalCategory == .format && value != 0x200C && value != 0x200D {
            return true
        }
        return false
    }

    private static func isVisibleScalar(_ scalar: Unicode.Scalar) -> Bool {
        !CharacterSet.whitespacesAndNewlines.contains(scalar)
            && scalar.properties.generalCategory != .format
    }
}

/// The only routes this package accepts. Preparing a message is a draft handoff, never a send operation.
public enum NativeActionRoute: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    case openConversation(threadID: DexterThreadID)
    case prepareMessage(threadID: DexterThreadID, draft: BoundedDraft)

    public var threadID: DexterThreadID {
        switch self {
        case .openConversation(let threadID), .prepareMessage(let threadID, _): threadID
        }
    }

    public var requiresInAppConfirmation: Bool {
        if case .prepareMessage = self { return true }
        return false
    }

    public var description: String {
        switch self {
        case .openConversation(let threadID): return "openConversation(threadID: \(threadID))"
        case .prepareMessage(let threadID, _): return "prepareMessage(threadID: \(threadID), draft: <redacted>)"
        }
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        switch self {
        case .openConversation(let threadID):
            return Mirror(self, children: [("threadID", threadID)], displayStyle: .enum)
        case .prepareMessage(let threadID, _):
            let children: [(label: String?, value: Any)] = [
                ("threadID", threadID),
                ("draft", "<redacted>"),
            ]
            return Mirror(self, children: children, displayStyle: .enum)
        }
    }
}

/// Exact-key parser shared by App Intents and the future scene router. Authority-bearing or unknown keys fail closed.
public enum NativeActionArgumentParser {
    public static func parse(_ arguments: [String: String]) throws -> NativeActionRoute {
        guard let action = arguments["action"], let threadValue = arguments["threadId"] else {
            throw NativeActionError.invalidArguments
        }
        let threadID = try DexterThreadID(threadValue)

        switch action {
        case "open_conversation":
            guard Set(arguments.keys) == ["action", "threadId"] else { throw NativeActionError.invalidArguments }
            return .openConversation(threadID: threadID)
        case "prepare_message":
            guard Set(arguments.keys) == ["action", "threadId", "draft"], let rawDraft = arguments["draft"] else {
                throw NativeActionError.invalidArguments
            }
            return .prepareMessage(threadID: threadID, draft: try BoundedDraft(rawDraft))
        default:
            throw NativeActionError.invalidArguments
        }
    }
}
