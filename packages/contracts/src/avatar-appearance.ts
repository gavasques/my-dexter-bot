import { z } from "zod";

/** Code-owned visual recipe only: no image bytes, remote URLs or execution authority. */
export const BOT_AVATAR_BODIES = ["round", "bean", "square", "capsule", "triangle", "hexagon", "cloud", "drop"] as const;
export const BOT_AVATAR_EYES = ["oval", "tall", "sleepy", "tiny", "dots", "focused", "glance", "wide"] as const;
export const BOT_AVATAR_FINISHES = ["flat", "glass"] as const;
export const BOT_AVATAR_MOTIONS = ["none", "subtle", "lively"] as const;
export const MAX_BOT_AVATAR_APPEARANCE_JSON_BYTES = 512;
export const BOT_AVATAR_APPEARANCES_META_KEY = "bot_avatar_appearances_v1";
export const MAX_BOT_AVATAR_APPEARANCES_METADATA_BYTES = 131_072;

export const BotAvatarAppearanceSchema = z.strictObject({
  version: z.literal(1),
  body: z.enum(BOT_AVATAR_BODIES),
  eyes: z.enum(BOT_AVATAR_EYES),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).overwrite(value => value.toUpperCase()),
  finish: z.enum(BOT_AVATAR_FINISHES),
  motion: z.enum(BOT_AVATAR_MOTIONS),
});
export type BotAvatarAppearance = z.infer<typeof BotAvatarAppearanceSchema>;

export const BotAvatarAppearancesConfigurationSchema = z.strictObject({
  version: z.literal(1),
  bots: z.record(z.string().regex(/^bot_[A-Za-z0-9_-]{1,124}$/), BotAvatarAppearanceSchema)
    .refine(value => Object.keys(value).length <= 500, "Too many bot avatar recipes."),
});
export type BotAvatarAppearancesConfiguration = z.infer<typeof BotAvatarAppearancesConfigurationSchema>;
export function defaultBotAvatarAppearancesConfiguration(): BotAvatarAppearancesConfiguration { return {version: 1, bots: {}}; }

/** Fixed key order and uppercase colors make backup/open admission byte-exact. */
export function botAvatarAppearanceJSON(appearance: BotAvatarAppearance): string {
  return JSON.stringify({version: appearance.version, body: appearance.body, eyes: appearance.eyes,
    colorHex: appearance.colorHex, finish: appearance.finish, motion: appearance.motion});
}
export function botAvatarAppearancesConfigurationJSON(config: BotAvatarAppearancesConfiguration): string {
  return JSON.stringify({version: config.version,
    bots: Object.fromEntries(Object.entries(config.bots).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([id, appearance]) => [id, JSON.parse(botAvatarAppearanceJSON(appearance))]))});
}
