import Foundation
import Observation
import DexterNativeActions

public struct NativeActionDestination: Equatable, Sendable {
    public let botID: String
    public let threadID: String
    public let handoffID: UUID
}

public struct NativeActionDraft: Equatable, Sendable, CustomReflectable {
    public let id: UUID
    public let version: UInt64
    public let threadID: String
    public let draft: BoundedDraft
    public let expiresAt: Date
    public var customMirror: Mirror { Mirror(self,children:["id":id,"threadID":threadID,"draft":"<redacted>"]) }
}
public enum NativeComposerSubmission: CustomReflectable {
    public var customMirror: Mirror { Mirror(self,children:["content":"<redacted>"]) }
    case manual(String)
    case native(id: UUID, version: UInt64, content: BoundedDraft)
}

/// Ephemeral text and two-phase human confirmation, scoped to one host and conversation.
@Observable @MainActor public final class NativeActionComposer: CustomReflectable {
    public let threadID: String
    public let hostScope: UUID?
    public private(set) var text = ""
    public private(set) var pendingReplacement: NativeActionDraft?
    public private(set) var receivedDraft: NativeActionDraft?
    public private(set) var isConfirming = false
    public private(set) var notice: String?
    public private(set) var scopeInvalidated = false
    @ObservationIgnored private var consumedIDs: Set<UUID> = []
    @ObservationIgnored private var revision: UInt64 = 0
    @ObservationIgnored private var candidate: Candidate?
    private struct Candidate {
        let revision: UInt64
        let text: String
        let nativeID: UUID?
    }
    public init(threadID: String, hostScope: UUID? = nil) { self.threadID = threadID; self.hostScope = hostScope }
    public nonisolated var customMirror: Mirror { Mirror(self,children:["text":"<redacted>"]) }
    public func edit(_ value: String) { revision &+= 1; text = value }
    public func offer(_ value: NativeActionDraft?, now: Date = Date()) {
        guard !scopeInvalidated else { return }
        guard let value, value.threadID == threadID, now < value.expiresAt else {
            invalidateNative(reason:"A solicitação terminou. Suas alterações ficaram como mensagem manual nesta conversa.")
            return
        }
        guard consumedIDs.count < 32, !consumedIDs.contains(value.id), receivedDraft?.id != value.id, pendingReplacement?.id != value.id else { return }
        if text.isEmpty { receivedDraft = value; text = value.draft.text; revision &+= 1 }
        else { pendingReplacement = value }
    }
    public func acceptReplacement(now: Date = Date()) {
        guard !isConfirming, !scopeInvalidated, let pendingReplacement, now < pendingReplacement.expiresAt else { return }
        receivedDraft = pendingReplacement; text = pendingReplacement.draft.text; revision &+= 1
        self.pendingReplacement = nil; notice = nil
    }
    /// TTL/authority loss discards external text, but retains human edits as manual text in this scope.
    public func invalidateNative(reason: String, invalidatingID: UUID? = nil) {
        if let receivedDraft, invalidatingID == nil || invalidatingID == receivedDraft.id {
            consumedIDs.insert(receivedDraft.id)
            if text == receivedDraft.draft.text { text = ""; revision &+= 1 }
            notice = reason; self.receivedDraft = nil
        }
        if let pendingReplacement, invalidatingID == nil || invalidatingID == pendingReplacement.id { consumedIDs.insert(pendingReplacement.id); self.pendingReplacement = nil }
    }
    /// A different host cannot inherit this composer's human text or pending permission.
    public func invalidateHostScope() {
        invalidateNative(reason:"O host mudou. Seu texto ficou retido aqui; descarte para começar no novo host.")
        scopeInvalidated = true
        notice = "O host mudou. Seu texto ficou retido aqui; descarte para começar no novo host."
    }
    /// Explicit discard/cancel/reset is allowed to remove human edits belonging to the native draft.
    public func clearNative() {
        if let receivedDraft { consumedIDs.insert(receivedDraft.id); text = ""; revision &+= 1 }
        if let pendingReplacement { consumedIDs.insert(pendingReplacement.id) }
        receivedDraft = nil; pendingReplacement = nil; notice = nil
    }
    /// Begin phase: capture immutable text/revision/target; do not clear text or consume permission.
    public func submission(now: Date = Date()) throws -> NativeComposerSubmission? {
        guard !isConfirming, !scopeInvalidated else { return nil }
        guard !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else { return nil }
        if let receivedDraft {
            guard now < receivedDraft.expiresAt, !consumedIDs.contains(receivedDraft.id) else {
                invalidateNative(reason:"A solicitação expirou. Revise suas alterações antes de enviar como mensagem manual.")
                return nil
            }
            let content = try BoundedDraft(text)
            candidate = Candidate(revision:revision,text:text,nativeID:receivedDraft.id)
            isConfirming = true; notice = nil
            return .native(id:receivedDraft.id,version:receivedDraft.version,content:content)
        }
        candidate = Candidate(revision:revision,text:text,nativeID:nil)
        isConfirming = true; notice = nil
        return .manual(text)
    }
    /// Commit only a true host acceptance; edits made while awaiting remain manual in the same scope.
    public func completeSubmission(accepted: Bool, reason: String? = nil, nativeAuthorityAvailable: Bool = true) {
        guard let candidate else { return }
        self.candidate = nil; isConfirming = false
        if accepted {
            if let id = candidate.nativeID {
                consumedIDs.insert(id)
                if receivedDraft?.id == id { receivedDraft = nil }
            }
            if revision == candidate.revision, text == candidate.text { text = ""; revision &+= 1 }
            else if !text.isEmpty { notice = "A mensagem foi aceita. Suas alterações posteriores ficaram como mensagem manual." }
        } else {
            notice = reason ?? "O envio não foi confirmado. Seu texto foi mantido; revise antes de tentar novamente."
            if !nativeAuthorityAvailable, let id = candidate.nativeID { invalidateNative(reason:notice!,invalidatingID:id) }
        }
    }
    /// Retry confirms the original pending content. Capture only unchanged composer text;
    /// a different edit stays visible even when that original request is accepted.
    public func beginRetry(content: String) -> Bool {
        guard !isConfirming, !scopeInvalidated,
              text.trimmingCharacters(in:.whitespacesAndNewlines) == content else { return false }
        candidate = Candidate(revision:revision,text:text,nativeID:receivedDraft?.id)
        isConfirming = true; notice = nil
        return true
    }
    public func clearManual(ifUnchanged value: String) { if text == value { text = ""; revision &+= 1 } }
}
