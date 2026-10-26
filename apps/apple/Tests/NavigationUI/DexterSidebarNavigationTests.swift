import XCTest
import DexterHostClient
@testable import DexterNavigationUI

/// Compiles the actual SharedApp sources in the isolated package documented with D12–D14.
final class DexterSidebarNavigationTests: XCTestCase {
    private func bot(_ id: String, _ name: String, role: String = "") -> Bot {
        Bot(id: id, name: name, profileId: "qa-profile", engine: .claude, ownerId: "qa-owner", createdAt: 1, roleDescription: role)
    }
    private func team(_ id: String, _ name: String, coordinator: String?, members: [String]) -> Team {
        Team(id: id, ownerId: "qa-owner", name: name, coordinatorBotId: coordinator, botIds: members, revision: 0, createdAt: 1, updatedAt: 1)
    }
    private var bots: [Bot] { [bot("c", "Coordenação"), bot("m", "Analista", role: "Revisão de preços"), bot("s", "Solo")] }
    private var teams: [Team] { [team("a", "Comércio", coordinator: "c", members: ["m", "c"]), team("b", "Pesquisa", coordinator: "c", members: ["c", "m"])] }
    private func projection(_ query: String = "") -> DexterSidebarProjection { .init(bots: bots, teams: teams, query: query) }

    func testTeamBotsAppearOnlyInsideTeamsAndCoordinatorIsSeparateFromMembers() {
        let p = projection()
        XCTAssertEqual(p.standaloneBots.map(\.id), ["s"])
        XCTAssertEqual(p.teamGroups.map(\.id), ["a", "b"])
        for group in p.teamGroups {
            XCTAssertEqual(group.coordinator?.id, "c")
            XCTAssertEqual(group.members.map(\.id), ["m"])
        }
    }
    func testMemberSearchKeepsTeamAndCoordinatorContextWithoutUnrelatedMembers() {
        let extra = bot("x", "Designer")
        let p = DexterSidebarProjection(bots: bots + [extra], teams: [team("a", "Comércio", coordinator: "c", members: ["x", "m", "c"])], query: "analista")
        XCTAssertTrue(p.isSearching)
        XCTAssertEqual(p.teamGroups.count, 1)
        XCTAssertEqual(p.teamGroups.first?.coordinator?.id, "c")
        XCTAssertEqual(p.teamGroups.first?.members.map(\.id), ["m"])
    }
    func testSearchIgnoresCaseAccentsAndWhitespaceAndIncludesRoles() {
        XCTAssertEqual(projection("  REVISAO  ").teamGroups.map(\.id), ["a", "b"])
        XCTAssertEqual(projection("COMERCIO").teamGroups.map(\.id), ["a"])
        XCTAssertEqual(projection("coordenacao").teamGroups.count, 2)
        XCTAssertFalse(projection(" \n ").isSearching)
        XCTAssertEqual(projection("SOLO").standaloneBots.map(\.id), ["s"])
        XCTAssertTrue(projection("ausente").teamGroups.isEmpty)
    }
    func testTeamNameSearchShowsItsCompleteComposition() {
        let groups = projection("Pesquisa").teamGroups
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.coordinator?.id, "c")
        XCTAssertEqual(groups.first?.members.map(\.id), ["m"])
    }
    func testProjectionDoesNotInventMissingBotsOrDuplicateMalformedMemberIDs() {
        let p = DexterSidebarProjection(bots: bots, teams: [team("a", "Time antigo", coordinator: "gone", members: ["gone", "m", "m"])], query: "")
        XCTAssertNil(p.teamGroups.first?.coordinator)
        XCTAssertEqual(p.teamGroups.first?.members.map(\.id), ["m"])
        XCTAssertEqual(p.standaloneBots.map(\.id), ["c", "s"])
        XCTAssertFalse(p.belongs("gone", to: "a"))
    }
    func testSharedMemberOccurrenceHasUniqueIdentityAndSelectedOriginIsPreserved() {
        let a = DexterSidebarSelection.teamBot(teamID: "a", botID: "m")
        let b = DexterSidebarSelection.teamBot(teamID: "b", botID: "m")
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(DexterSidebarSelection.current(botID: "m", teamID: nil, origin: b, projection: projection()), b)
    }
    func testExternalBotSelectionFallsBackToOneCanonicalOccurrence() {
        XCTAssertEqual(DexterSidebarSelection.current(botID: "m", teamID: nil, origin: nil, projection: projection()), .teamBot(teamID: "a", botID: "m"))
        XCTAssertEqual(DexterSidebarSelection.current(botID: "s", teamID: nil, origin: .teamBot(teamID: "b", botID: "m"), projection: projection()), .bot("s"))
    }
    func testTeamConversationSelectionStaysDistinctFromCoordinatorPrivateSelection() {
        XCTAssertEqual(DexterSidebarSelection.current(botID: "c", teamID: "b", origin: .teamBot(teamID: "a", botID: "c"), projection: projection()), .team("b"))
        XCTAssertEqual(DexterSidebarSelection.current(botID: "c", teamID: nil, origin: nil, projection: projection()), .teamBot(teamID: "a", botID: "c"))
    }
    func testRemovedMembershipReconcilesOriginWithoutInventingASelection() {
        let origin = DexterSidebarSelection.teamBot(teamID: "b", botID: "m")
        let p = DexterSidebarProjection(bots: bots, teams: [], query: "")
        XCTAssertEqual(DexterSidebarSelection.current(botID: "m", teamID: nil, origin: origin, projection: p), .bot("m"))
        XCTAssertNil(DexterSidebarSelection.current(botID: "gone", teamID: nil, origin: origin, projection: p))
        XCTAssertNil(DexterSidebarSelection.current(botID: nil, teamID: nil, origin: nil, projection: p))
    }
    func testSearchNeverReassignsSelectedSharedMemberOrigin() {
        let origin = DexterSidebarSelection.teamBot(teamID: "b", botID: "m")
        XCTAssertEqual(DexterSidebarSelection.current(botID: "m", teamID: nil, origin: origin, projection: projection("Comércio")), origin)
    }
    func testSearchExposesCollapsedNativeSectionsAndRestoresTheirIndependentChoices() {
        var expansion = DexterSidebarExpansion()
        expansion.setExpanded(false, section: .bots, searching: false)
        expansion.setExpanded(false, section: .teams, searching: false)
        for section in [DexterSidebarExpansion.Section.bots, .teams] {
            XCTAssertFalse(expansion.isExpanded(section, searching: false))
            XCTAssertTrue(expansion.isExpanded(section, searching: projection("analista").isSearching))
            // A native disclosure attempt while searching cannot hide results or rewrite restoration.
            expansion.setExpanded(false, section: section, searching: true)
            XCTAssertTrue(expansion.isExpanded(section, searching: true))
            expansion.setExpanded(true, section: section, searching: true)
            XCTAssertFalse(expansion.isExpanded(section, searching: projection().isSearching))
        }
        expansion.setExpanded(true, section: .bots, searching: false)
        XCTAssertTrue(expansion.isExpanded(.bots, searching: false))
        XCTAssertFalse(expansion.isExpanded(.teams, searching: false))
    }
    func testSearchPreservesTeamCollapseSeparatelyFromNativeSectionCollapse() {
        var expansion = DexterSidebarExpansion()
        expansion.setExpanded(false, section: .teams, searching: false)
        expansion.setExpanded(false, teamID: "a", searching: false)
        XCTAssertTrue(expansion.isExpanded(.teams, searching: true))
        XCTAssertTrue(expansion.isExpanded(teamID: "a", searching: true))
        expansion.setExpanded(true, teamID: "a", searching: true)
        expansion.setExpanded(false, teamID: "b", searching: true)
        XCTAssertFalse(expansion.isExpanded(teamID: "a", searching: false))
        XCTAssertTrue(expansion.isExpanded(teamID: "b", searching: false))
        expansion.setExpanded(true, section: .teams, searching: false)
        XCTAssertFalse(expansion.isExpanded(teamID: "a", searching: false))
        expansion.setExpanded(true, teamID: "a", searching: false)
        XCTAssertTrue(expansion.isExpanded(teamID: "a", searching: false))
    }
}
