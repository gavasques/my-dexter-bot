/// Row highlight is an intent, not the canonical presented conversation.
public struct DexterThreadListSelection: Equatable, Sendable {
    public private(set) var selectedID: String?
    public init() {}
    public mutating func select(_ id: String?, in ids: [String]) {
        selectedID = id.flatMap { ids.contains($0) ? $0 : nil }
    }
    public mutating func reconcile(in ids: [String]) { select(selectedID, in: ids) }
    public mutating func move(_ offset: Int, in ids: [String]) {
        guard !ids.isEmpty else { selectedID = nil; return }
        let next: Int
        if let selectedID, let index = ids.firstIndex(of: selectedID) {
            next = min(max(index + offset, 0), ids.count - 1)
        } else { next = offset < 0 ? ids.count - 1 : 0 }
        selectedID = ids[next]
    }
    public func activation(in ids: [String]) -> String? {
        selectedID.flatMap { ids.contains($0) ? $0 : nil }
    }
}
