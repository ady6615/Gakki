/**
 * Unified Command Permissions Classification for Gakki.
 */
export enum CommandPermissionLevel {
  USER = 0,
  DJ = 1,
  MODERATOR = 2,
  ADMIN = 3,
  OWNER = 4,
}

export type CommandCategory =
  | 'PLAYBACK'
  | 'PLAYLISTS'
  | 'DJ'
  | 'LIBRARY'
  | 'SETTINGS'
  | 'ADMIN';

export interface CommandDefinition {
  name: string;
  description: string;
  category: CommandCategory;
  requiredLevel: CommandPermissionLevel;
  usage?: string;
  examples?: string[];
}
