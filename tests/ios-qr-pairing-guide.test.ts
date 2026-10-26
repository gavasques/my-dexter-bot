import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APP_CONFIGURATION_GUIDE_PAGES, IOS_QR_PAIRING_GUIDE_CONTENT_SHA256, IOS_QR_PAIRING_GUIDE_REVISION,
  IOS_QR_PAIRING_GUIDE_VERSION, readAppConfigurationGuidePage, readHarnessGuideTopic } from "@dexter/context";

test("QR manual is progressively discoverable with rendered revision, exact content hash and operational controls", () => {
  const page = readAppConfigurationGuidePage("ios-qr-pairing");
  assert.equal(APP_CONFIGURATION_GUIDE_PAGES.find(value => value.id === page.id)?.sha256, page.sha256);
  assert.equal(createHash("sha256").update(page.markdown).digest("hex"), page.sha256);
  assert.match(IOS_QR_PAIRING_GUIDE_CONTENT_SHA256, /^[a-f0-9]{64}$/);
  assert(page.markdown.includes(IOS_QR_PAIRING_GUIDE_VERSION));
  assert(page.markdown.includes(IOS_QR_PAIRING_GUIDE_REVISION));
  assert(readHarnessGuideTopic("configuration").markdown.includes("ios-qr-pairing"));
  assert(page.fields.length >= 24);
  for (const field of page.fields) {
    for (const key of ["title", "purpose", "scope", "read", "change", "approval", "result", "recovery"] as const)
      assert(field[key].length > 0, `${field.id}/${key}`);
    assert.equal(field.availability, "human_only", field.id);
    assert.equal(field.changeOperation, null, "a manual never grants a bot pairing authority");
  }
});

test("Mac renewal has its own local scope and explicit recovery instead of the iPhone claim recovery", () => {
  const owner = readAppConfigurationGuidePage("owner-pairing-offer");
  const view = readFileSync("apps/apple/SharedApp/Sources/OwnerPairingOfferViews.swift", "utf8");
  for (const id of ["owner-pairing-offer.prepare-channel", "owner-pairing-offer.renew.open", "owner-pairing-offer.renew.confirm",
    "owner-pairing-offer.renew.cancel", "owner-pairing-offer.resume-channel"]) {
    const field = owner.fields.find(value => value.id === id);
    assert(field, id);
    assert(field.scope.includes("base própria iniciada pelo app deste Mac"), id);
    assert(field.approval.includes("Gesto humano"), id);
    assert.equal(field.changeOperation, null, id);
    assert.equal(field.availability, "human_only", id);
    assert(view.includes(`accessibilityIdentifier("${id}")`), `${id} is an actual Apple control`);
  }
  const renew = owner.fields.find(value => value.id === "owner-pairing-offer.renew.confirm")!;
  for (const text of ["CAS", "UUID", "creation", "host/dono", "Não remove nem sobrescreve", "novo QR"])
    assert(`${renew.read} ${renew.change} ${renew.result}`.includes(text), text);
  assert(renew.recovery.includes("Startup e Apply nunca rotacionam"));
  assert(renew.recovery.includes("parada incerta conserva o writer"));
  const prepare = owner.fields.find(value => value.id === "owner-pairing-offer.prepare-channel")!;
  assert(prepare.result.includes("localChatOnly"));
  assert(prepare.result.includes("não sucesso do pareamento"));
});

test("camera and claims stay explicit while private invitation bytes remain outside public state", () => {
  const page = readAppConfigurationGuidePage("ios-qr-pairing");
  const notes = page.notes.join("\n");
  for (const text of ["2953", "8192", "não em chat", "background", "Nenhum key provision/claim antes de Conectar",
    "sem autoaprovação", "365dias", "não bloqueia o chat local"]) assert(notes.includes(text), text);
  const renew = readAppConfigurationGuidePage("owner-pairing-offer").fields.find(value => value.id === "owner-pairing-offer.renew.confirm")!;
  assert(renew.result.includes("Nenhum convite, claim, escopo ou grant"));
});
