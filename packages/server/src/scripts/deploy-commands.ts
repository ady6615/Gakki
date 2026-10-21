import dotenv from 'dotenv';
import path from 'node:path';
import { REST, Routes } from 'discord.js';
import { slashCommandDefinitions } from '../discord/commands';

// Load .env from root or packages/server
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '..', '.env') });

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  console.error('❌ DISCORD_TOKEN or DISCORD_CLIENT_ID missing in environment');
  process.exit(1);
}

const activeToken: string = token;
const activeClientId: string = clientId;

const rest = new REST({ version: '10' }).setToken(activeToken);

async function deploy() {
  console.log(`🚀 Deploying ${slashCommandDefinitions.length} slash commands...`);
  console.log(`📋 Client ID: ${activeClientId}`);

  // 1. Deploy Global Slash Commands
  console.log('📡 Updating global slash commands...');
  try {
    const globalData = (await rest.put(Routes.applicationCommands(activeClientId), {
      body: slashCommandDefinitions,
    })) as any[];
    console.log(`✅ Global commands updated successfully (${globalData.length} commands).`);
  } catch (err: any) {
    console.error('❌ Failed to update global commands:', err?.message || err);
  }

  // 2. Fetch all joined guilds and update guild slash commands immediately
  try {
    console.log('🌐 Fetching joined guilds...');
    const guilds = (await rest.get(Routes.userGuilds())) as Array<{ id: string; name: string }>;
    console.log(`🏰 Bot belongs to ${guilds.length} guild(s):`);

    for (const guild of guilds) {
      console.log(`   - Updating commands in "${guild.name}" (ID: ${guild.id})...`);
      try {
        const guildData = (await rest.put(Routes.applicationGuildCommands(activeClientId, guild.id), {
          body: slashCommandDefinitions,
        })) as any[];
        console.log(`     ✅ Successfully updated ${guildData.length} commands in "${guild.name}"`);
      } catch (gErr: any) {
        console.error(`     ❌ Failed to update commands in "${guild.name}":`, gErr?.message || gErr);
      }
    }
  } catch (guildsErr: any) {
    console.error('❌ Failed to fetch user guilds:', guildsErr?.message || guildsErr);
  }

  console.log('\n🎉 Command deployment complete!');
  console.log('💡 Note: If you still see cached commands in Discord desktop/mobile, press Ctrl+R to refresh Discord.');
}

deploy().catch((err) => {
  console.error('Deployment encountered fatal error:', err);
  process.exit(1);
});
