import DexterAppCore
import DexterHostClient
import SwiftUI

#if os(macOS)
/// Sidebar row for a group. A group is its own entity: it is not a team, has no coordinator and
/// never changes a bot's own conversation, documents or grants.
@MainActor struct GroupSidebarRow: View {
    let group: BotGroup
    let model: DexterAppModel

    private var members: [Bot] { group.activeBotIDs.compactMap { id in model.bots.first { $0.id == id } } }

    var body: some View {
        HStack(spacing: 10) {
            GroupAvatarStack(bots: members, model: model, size: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text(group.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    .foregroundStyle(group.archived ? .secondary : .primary)
                Text(verbatim: (group.archived ? String(localized: "Arquivado · ") : "") + members.map(\.name).joined(separator: ", "))
                    .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 40)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: group.archived ? String(localized: "\(group.name), Grupo com \(members.count) bots, arquivado") : String(localized: "\(group.name), Grupo com \(members.count) bots")))
    }
}

/// Overlapping member avatars; purely visual.
@MainActor struct GroupAvatarStack: View {
    let bots: [Bot]
    let model: DexterAppModel
    var size: CGFloat = 32

    var body: some View {
        let shown = Array(bots.prefix(3))
        ZStack(alignment: .topLeading) {
            if shown.isEmpty {
                DexterAvatarView(image: nil, emoji: nil, fallbackSystemImage: "bubble.left.and.bubble.right", model: model, size: size)
            } else if shown.count == 1 {
                avatar(shown[0], size: size)
            } else {
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, bot in
                    avatar(bot, size: size * 0.6).offset(x: CGFloat(index) * size * 0.2, y: CGFloat(index % 2) * size * 0.38)
                }
            }
        }
        .frame(width: size, height: size, alignment: .topLeading)
        .accessibilityHidden(true)
    }
    private func avatar(_ bot: Bot, size: CGFloat) -> some View {
        DexterAvatarView(image: bot.avatarImage, emoji: bot.avatarEmoji,
                         fallbackSystemImage: bot.engine == .claude ? "sparkles" : "terminal", model: model, size: size, appearance: bot.avatarAppearance, mascotSeed: bot.id)
            .overlay(RoundedRectangle(cornerRadius: max(8, size * 0.24)).stroke(DexterSurface.avatarRing, lineWidth: 1.5))
    }
}

/// Always-visible roster above the group transcript: who is in the group and what each one can read.
@MainActor struct GroupRosterBar: View {
    let group: BotGroup
    let model: DexterAppModel
    let onEdit: () -> Void
    let canEdit: Bool

    var body: some View {
        HStack(spacing: 12) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(group.members.filter(\.active), id: \.botId) { member in
                        if let bot = model.bots.first(where: { $0.id == member.botId }) {
                            HStack(spacing: 6) {
                                DexterAvatarView(image: bot.avatarImage, emoji: bot.avatarEmoji,
                                                 fallbackSystemImage: bot.engine == .claude ? "sparkles" : "terminal", model: model, size: 22, appearance: bot.avatarAppearance, mascotSeed: bot.id)
                                Text(bot.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                            }
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(DexterSurface.raisedFill, in: Capsule())
                            .help(member.history == .all ? "\(bot.name) lê todo o histórico do grupo." : "\(bot.name) lê o grupo a partir de quando entrou.")
                            .accessibilityElement(children: .combine)
                            .accessibilityValue(member.history == .all ? "Lê todo o histórico" : "Lê a partir da entrada")
                            .accessibilityIdentifier("group.roster.\(bot.id)")
                        }
                    }
                }
            }
            Button("Editar grupo", action: onEdit).controlSize(.small).disabled(!canEdit || group.archived)
                .accessibilityIdentifier("group.edit")
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("group.roster")
    }
}
#endif
