import {
  PermissionsBitField,
  type CommandInteraction,
  type GuildMember,
} from 'discord.js';
import { CommandPermissionLevel } from '@gakki/core';

export { CommandPermissionLevel };

/**
 * Resolves the permission tier of a Discord interaction user within their guild.
 */
export function resolveUserPermissionLevel(
  interaction: CommandInteraction,
  botOwnerId?: string
): CommandPermissionLevel {
  const userId = interaction.user.id;

  // Bot Owner check
  if (botOwnerId && userId === botOwnerId) {
    return CommandPermissionLevel.OWNER;
  }

  // Guild check
  if (!interaction.guild || !interaction.member) {
    return CommandPermissionLevel.USER;
  }

  // Guild Owner check
  if (interaction.guild.ownerId === userId) {
    return CommandPermissionLevel.OWNER;
  }

  const member = interaction.member as GuildMember;
  const permissions = member.permissions;

  // Administrator or Manage Guild -> ADMIN
  if (
    permissions.has(PermissionsBitField.Flags.Administrator) ||
    permissions.has(PermissionsBitField.Flags.ManageGuild)
  ) {
    return CommandPermissionLevel.ADMIN;
  }

  // Moderation permissions -> MODERATOR
  if (
    permissions.has(PermissionsBitField.Flags.ManageChannels) ||
    permissions.has(PermissionsBitField.Flags.BanMembers) ||
    permissions.has(PermissionsBitField.Flags.KickMembers)
  ) {
    return CommandPermissionLevel.MODERATOR;
  }

  // DJ Role check or Alone in Voice
  const hasDjRole = member.roles.cache.some(
    (role) => role.name.toLowerCase() === 'dj' || role.name.toLowerCase() === 'music master'
  );
  if (hasDjRole) {
    return CommandPermissionLevel.DJ;
  }

  // If user is alone in voice channel with the bot, grant temporary DJ capability
  const voiceChannel = member.voice?.channel;
  if (voiceChannel && voiceChannel.members.size <= 2) {
    return CommandPermissionLevel.DJ;
  }

  return CommandPermissionLevel.USER;
}

/**
 * Check if the user meets the required permission tier.
 */
export function checkCommandPermission(
  interaction: CommandInteraction,
  requiredLevel: CommandPermissionLevel,
  botOwnerId?: string
): { allowed: boolean; userLevel: CommandPermissionLevel } {
  const userLevel = resolveUserPermissionLevel(interaction, botOwnerId);
  return {
    allowed: userLevel >= requiredLevel,
    userLevel,
  };
}

/**
 * Dedicated permission check for voice recording operations (Requirement 5).
 * Requires RECORDING_OPERATOR role, MODERATOR, ADMIN, or OWNER.
 */
export function checkRecordingPermission(
  interaction: CommandInteraction,
  botOwnerId?: string
): { allowed: boolean; userLevel: CommandPermissionLevel } {
  const userLevel = resolveUserPermissionLevel(interaction, botOwnerId);

  // If user is MODERATOR or above
  if (userLevel >= CommandPermissionLevel.MODERATOR) {
    return { allowed: true, userLevel };
  }

  // Check for dedicated 'Recording Operator' role
  if (interaction.member && 'roles' in interaction.member) {
    const member = interaction.member as GuildMember;
    const hasRecordingRole = member.roles.cache.some(
      (role) =>
        role.name.toLowerCase() === 'recording operator' ||
        role.name.toLowerCase() === 'recording' ||
        role.name.toLowerCase() === 'recorder'
    );
    if (hasRecordingRole) {
      return { allowed: true, userLevel };
    }
  }

  return { allowed: false, userLevel };
}

