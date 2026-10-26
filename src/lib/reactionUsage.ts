// Частые реакции на сообщения — у каждого свои, хранятся только в этом браузере.

import { MESSAGE_REACTIONS, isMessageReaction } from "../../shared/protocol.ts";
import { load, save } from "./storage.ts";

type Usage = Record<string, { n: number; at: number }>;

/**
 * Быстрый ряд реакций: впереди самые частые (при равенстве — недавние), свободные места
 * занимает стандартный набор. Пока своих частых нет, ряд — просто стандартный набор.
 */
export function quickReactions(): string[] {
  const usage = load<Usage>("reactionUsage", {});
  const frequent = Object.entries(usage)
    .filter(([emoji]) => isMessageReaction(emoji))
    .sort(([, a], [, b]) => b.n - a.n || b.at - a.at)
    .map(([emoji]) => emoji);
  return [...new Set([...frequent, ...MESSAGE_REACTIONS])].slice(0, MESSAGE_REACTIONS.length);
}

/** Засчитать поставленную реакцию (снятие своей реакции не считается). */
export function rememberReaction(emoji: string): void {
  const usage = load<Usage>("reactionUsage", {});
  usage[emoji] = { n: (usage[emoji]?.n ?? 0) + 1, at: Date.now() };
  save("reactionUsage", usage);
}
