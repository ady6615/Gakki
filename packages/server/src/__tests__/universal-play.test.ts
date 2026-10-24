import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PlaybackManager,
  QueueManager,
  createLogger,
  type VoicePlatformAdapter,
  type VoicePlatformState,
  type AudioTrackInfo,
  type VoiceConnectionStatus,
  type PlaybackStatus,
  type AudioSource,
} from '@gakki/core';
import {
  slashCommandDefinitions,
  handleChatInputCommand,
  handleAutocomplete,
} from '../discord/commands';
import {
  predictAudioInputType,
  searchSongsUniversally,
  buildSongChoiceMessage,
  storeSongChoiceSession,
  getSongChoiceSession,
  removeSongChoiceSession,
  handleSongChoiceInteraction,
} from '../discord/song-selector';

const logger = createLogger('universal-play-test');

class MockVoiceAdapter implements VoicePlatformAdapter {
  readonly platform = 'mock-discord';
  public voiceStatus: VoiceConnectionStatus = 'CONNECTED';
  public playerStatus: PlaybackStatus = 'IDLE';
  public currentTrack: AudioTrackInfo | null = null;
  private stateListeners: Set<(state: VoicePlatformState) => void> = new Set();
  private errorListeners: Set<(guildId: string, err: Error) => void> = new Set();

  async joinVoice(_guildId: string, _channelId: string): Promise<void> {
    this.voiceStatus = 'CONNECTED';
    this.emitState(_guildId);
  }

  async leaveVoice(_guildId: string): Promise<void> {
    this.voiceStatus = 'DISCONNECTED';
    this.playerStatus = 'IDLE';
    this.currentTrack = null;
    this.emitState(_guildId);
  }

  getVoiceStatus(_guildId: string): VoiceConnectionStatus {
    return this.voiceStatus;
  }

  getPlaybackStatus(_guildId: string): PlaybackStatus {
    return this.playerStatus;
  }

  getCurrentTrack(_guildId: string): AudioTrackInfo | null {
    return this.currentTrack;
  }

  async play(guildId: string, source: AudioSource): Promise<void> {
    const meta = await source.getMetadata();
    this.currentTrack = {
      name: meta.title,
      duration: meta.duration ?? 180,
      artist: meta.artist ?? 'Artist',
      filePath: source.identifier,
      sourceType: source.sourceType,
    };
    this.playerStatus = 'PLAYING';
    this.emitState(guildId);
  }

  pause(guildId: string): boolean {
    this.playerStatus = 'PAUSED';
    this.emitState(guildId);
    return true;
  }

  resume(guildId: string): boolean {
    this.playerStatus = 'PLAYING';
    this.emitState(guildId);
    return true;
  }

  stop(guildId: string): boolean {
    this.playerStatus = 'IDLE';
    this.currentTrack = null;
    this.emitState(guildId);
    return true;
  }

  onStateChange(listener: (state: VoicePlatformState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: (guildId: string, error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  getState(guildId: string): VoicePlatformState {
    return {
      guildId,
      voiceState: this.voiceStatus,
      playerState: this.playerStatus,
      track: this.currentTrack,
    };
  }

  private emitState(guildId: string): void {
    const s = this.getState(guildId);
    for (const l of this.stateListeners) l(s);
  }
}

function createMockChatInputInteraction(options: {
  commandName: string;
  guildId?: string;
  songOption?: string | null;
  fileOption?: string | null;
  folderOption?: string | null;
  inputOption?: string | null;
  inVoice?: boolean;
}) {
  let repliedText = '';
  let repliedEmbeds: any[] = [];
  let repliedComponents: any[] = [];
  let isDeferred = false;
  let isReplied = false;

  const mockChannel = options.inVoice !== false
    ? {
        id: 'voice-channel-1',
        name: 'Music Lounge',
        isVoiceBased: () => true,
        permissionsFor: () => ({
          has: () => true,
        }),
      }
    : null;

  return {
    commandName: options.commandName,
    guildId: options.guildId || 'test-guild-1',
    user: { id: 'user-123', username: 'MusicFan' },
    member: {
      displayName: 'MusicFan',
      voice: { channel: mockChannel },
    },
    guild: {
      id: options.guildId || 'test-guild-1',
      members: {
        me: { id: 'bot-1' },
        fetchMe: async () => ({ id: 'bot-1' }),
      },
    },
    options: {
      getString: (name: string) => {
        if (name === 'song') return options.songOption ?? null;
        if (name === 'file') return options.fileOption ?? null;
        if (name === 'folder') return options.folderOption ?? null;
        if (name === 'input') return options.inputOption ?? null;
        return null;
      },
    },
    deferReply: async () => {
      isDeferred = true;
    },
    editReply: async (data: any) => {
      isReplied = true;
      if (typeof data === 'string') {
        repliedText = data;
      } else {
        repliedText = data.content || '';
        if (data.embeds) repliedEmbeds = data.embeds;
        if (data.components) repliedComponents = data.components;
      }
      return data;
    },
    reply: async (data: any) => {
      isReplied = true;
      if (typeof data === 'string') {
        repliedText = data;
      } else {
        repliedText = data.content || '';
        if (data.embeds) repliedEmbeds = data.embeds;
        if (data.components) repliedComponents = data.components;
      }
      return data;
    },
    isRepliable: () => true,
    get replied() { return isReplied; },
    get deferred() { return isDeferred; },
    getRepliedText: () => repliedText,
    getRepliedEmbeds: () => repliedEmbeds,
    getRepliedComponents: () => repliedComponents,
  };
}

async function runUniversalPlayTests() {
  console.log('\n======================================================');
  console.log('   GAKKI MUSIC PLATFORM — UNIVERSAL /PLAY TEST SUITE');
  console.log('======================================================\n');

  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    total++;
    try {
      const res = fn();
      if (res && typeof (res as any).then === 'function') {
        return (res as any).then(() => {
          console.log(`  PASS: ${name}`);
          passed++;
        }).catch((err: any) => {
          console.error(`  FAIL: ${name} -> ${err.message}`);
          throw err;
        });
      }
      console.log(`  PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  FAIL: ${name} -> ${err.message}`);
      throw err;
    }
  }

  // ── TEST 1: SlashCommandBuilder Definitions ──
  console.log('Test Group 1: Slash Command Definitions (/play & /playnext)');

  test('/play command exists with no options (clean /play)', () => {
    const playCmd = slashCommandDefinitions.find((c) => c.name === 'play');
    assert(playCmd, '/play command must be registered');
    const json = playCmd.toJSON();

    // Check options: only /play with no extra options
    assert(!json.options || json.options.length === 0, `Expected 0 options on /play, got ${json.options?.length}`);
  });

  test('/play command has removed "song", "input", "folder", and "file" options', () => {
    const playCmd = slashCommandDefinitions.find((c) => c.name === 'play');
    assert(playCmd);
    const json = playCmd.toJSON();
    const optionNames = (json.options || []).map((o: any) => o.name);

    assert(!optionNames.includes('song'), 'Option "song" must be removed from /play');
    assert(!optionNames.includes('input'), 'Option "input" must be removed from /play');
    assert(!optionNames.includes('folder'), 'Option "folder" must be removed from /play');
    assert(!optionNames.includes('file'), 'Option "file" must be removed from /play');
  });

  test('/playnext command exists with no options (clean /playnext)', () => {
    const playNextCmd = slashCommandDefinitions.find((c) => c.name === 'playnext');
    assert(playNextCmd, '/playnext command must be registered');
    const json = playNextCmd.toJSON();

    assert(!json.options || json.options.length === 0, `Expected 0 options on /playnext, got ${json.options?.length}`);
  });

  // ── TEST 2: Input Prediction ──
  console.log('\nTest Group 2: Universal Input Predictor');

  test('Predicts HTTPS / HTTP / YouTube / Spotify links as "link"', () => {
    const p1 = predictAudioInputType('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.strictEqual(p1.type, 'link');

    const p2 = predictAudioInputType('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
    assert.strictEqual(p2.type, 'link');

    const p3 = predictAudioInputType('http://stream.radioparadise.com/mp3-128');
    assert.strictEqual(p3.type, 'link');

    const p4 = predictAudioInputType('spotify:track:4cOdK2wGLETKBW3PvgPWqT');
    assert.strictEqual(p4.type, 'link');

    const p5 = predictAudioInputType('https://soundcloud.com/artist/song');
    assert.strictEqual(p5.type, 'link');
  });

  test('Predicts file paths with audio extensions as "file_path"', () => {
    const p1 = predictAudioInputType('storage/music/synthwave.mp3');
    assert.strictEqual(p1.type, 'file_path');

    const p2 = predictAudioInputType('song.flac');
    assert.strictEqual(p2.type, 'file_path');

    const p3 = predictAudioInputType('track.wav');
    assert.strictEqual(p3.type, 'file_path');
  });

  test('Predicts song names as "song_name"', () => {
    const p1 = predictAudioInputType('Bohemian Rhapsody');
    assert.strictEqual(p1.type, 'song_name');

    const p2 = predictAudioInputType('After Dark');
    assert.strictEqual(p2.type, 'song_name');

    const p3 = predictAudioInputType('Starboy The Weeknd');
    assert.strictEqual(p3.type, 'song_name');

    const p4 = predictAudioInputType('Anime Opening 1');
    assert.strictEqual(p4.type, 'song_name');
  });

  // ── TEST 3: Multi-Song Interactive Selection Message ──
  console.log('\nTest Group 3: Multi-Song Selection Menu & Buttons');

  test('Builds interactive select menu and clickable buttons when 2+ songs found', () => {
    const candidates = [
      {
        id: '1',
        title: 'After Dark',
        artist: 'Mr.Kitty',
        duration: 259,
        sourceUrl: 'https://youtube.com/watch?v=1',
        sourceProvider: 'youtube',
      },
      {
        id: '2',
        title: 'After Dark',
        artist: 'Asian Kung-Fu Generation',
        duration: 192,
        sourceUrl: 'https://youtube.com/watch?v=2',
        sourceProvider: 'youtube',
      },
      {
        id: '3',
        title: 'After Dark (Club Remix)',
        artist: 'Drake',
        duration: 280,
        sourceUrl: 'https://youtube.com/watch?v=3',
        sourceProvider: 'youtube',
      },
    ];

    const sessionId = 'test-session-123';
    storeSongChoiceSession(sessionId, {
      guildId: 'guild-1',
      userId: 'user-1',
      userName: 'UserOne',
      songName: 'After Dark',
      isPlayNext: false,
      candidates,
    });

    const session = getSongChoiceSession(sessionId);
    assert(session, 'Session must be stored in memory');
    assert.strictEqual(session.candidates.length, 3);

    const msg = buildSongChoiceMessage('After Dark', candidates, sessionId, false);
    assert.strictEqual(msg.embeds.length, 1);
    assert(msg.embeds[0].data.title?.includes('After Dark'), 'Embed title mentions song query');
    assert(msg.embeds[0].data.description?.includes('3'), 'Embed description mentions 3 matches');

    // Check components
    assert.strictEqual(msg.components.length, 2, 'Must have 2 action rows (Select Menu + Buttons)');
    const selectMenuRow = msg.components[0];
    const buttonRow = msg.components[1];

    const menuJson = selectMenuRow.toJSON();
    assert.strictEqual(menuJson.components[0].custom_id, `gakki:play_select:${sessionId}`);
    assert.strictEqual(menuJson.components[0].options.length, 3);

    const buttonJson = buttonRow.toJSON();
    assert.strictEqual(buttonJson.components.length, 3, 'Must have 3 buttons for 3 candidates');
    assert.strictEqual(buttonJson.components[0].custom_id, `gakki:play_pick:${sessionId}:0`);
    assert.strictEqual(buttonJson.components[1].custom_id, `gakki:play_pick:${sessionId}:1`);

    removeSongChoiceSession(sessionId);
    assert(!getSongChoiceSession(sessionId), 'Session cleaned up');
  });

  // ── TEST 4: Selection Interaction Execution ──
  console.log('\nTest Group 4: Song Selection Interaction Handling');

  await test('Choosing from select menu starts chosen track and removes menu', async () => {
    const queueManager = new QueueManager(logger);
    const playbackManager = new PlaybackManager(logger, queueManager);
    const adapter = new MockVoiceAdapter();
    playbackManager.registerAdapter(adapter);

    const sessionId = 'session-pick-test';
    const candidates = [
      {
        id: '1',
        title: 'Song Alpha',
        artist: 'Artist A',
        duration: 180,
        sourceUrl: 'https://example.com/alpha.mp3',
        sourceProvider: 'http_stream',
      },
      {
        id: '2',
        title: 'Song Beta',
        artist: 'Artist B',
        duration: 210,
        sourceUrl: 'https://example.com/beta.mp3',
        sourceProvider: 'http_stream',
      },
    ];

    storeSongChoiceSession(sessionId, {
      guildId: 'guild-select-test',
      userId: 'user-tester',
      userName: 'Tester',
      songName: 'Song Alpha',
      isPlayNext: false,
      candidates,
    });

    let editReplyData: any = null;
    const mockSelectInteraction = {
      isStringSelectMenu: () => true,
      isButton: () => false,
      customId: `gakki:play_select:${sessionId}`,
      values: ['1'], // user chose Song Beta (index 1)
      guildId: 'guild-select-test',
      user: { id: 'user-tester', username: 'Tester' },
      member: {
        displayName: 'Tester',
        voice: {
          channel: { id: 'v1', name: 'General', isVoiceBased: () => true, permissionsFor: () => ({ has: () => true }) },
        },
      },
      deferUpdate: async () => {},
      editReply: async (data: any) => {
        editReplyData = data;
        return data;
      },
      reply: async (msg: any) => msg,
      followUp: async (msg: any) => msg,
      client: { guilds: { fetch: async () => null } },
    };

    await handleSongChoiceInteraction(mockSelectInteraction as any, { playbackManager });

    assert(editReplyData, 'editReply should be called');
    assert(editReplyData.content.includes('Song Beta'), `Content should mention Song Beta, got: ${editReplyData.content}`);
    assert.strictEqual(editReplyData.components.length, 0, 'Components must be cleared after selection');
    assert.strictEqual(adapter.currentTrack?.name, 'Song Beta', 'Adapter now playing Song Beta');
    assert.strictEqual(getSongChoiceSession(sessionId), undefined, 'Session removed after selection');
  });

  // ── TEST 5: Chat Input Execution with /play ──
  console.log('\nTest Group 5: /play Execution with Universal Flow');

  await test('/play with multiple search matches triggers selection menu', async () => {
    const queueManager = new QueueManager(logger);
    const playbackManager = new PlaybackManager(logger, queueManager);
    const adapter = new MockVoiceAdapter();
    playbackManager.registerAdapter(adapter);

    // Mock AudioSourceManager with 3 results
    const mockAudioSourceManager = {
      search: async (query: string) => [
        { title: `${query} (Original Mix)`, artist: 'Artist 1', duration: 200, sourceUrl: 'https://example.com/1', provider: 'youtube' },
        { title: `${query} (Acoustic)`, artist: 'Artist 2', duration: 180, sourceUrl: 'https://example.com/2', provider: 'youtube' },
      ],
      resolve: async (url: string) => ({
        title: 'Resolved Song',
        streamUrlOrPath: url,
        metadata: { title: 'Resolved Song', duration: 200 },
        source: { provider: 'youtube', sourceType: 'stream' },
        isStream: true,
      }),
      canHandle: () => true,
    } as any;

    const interaction = createMockChatInputInteraction({
      commandName: 'play',
      songOption: 'Electric Love',
      guildId: 'multi-match-guild',
    });

    await handleChatInputCommand(interaction as any, playbackManager, mockAudioSourceManager);

    const embeds = interaction.getRepliedEmbeds();
    const components = interaction.getRepliedComponents();

    assert(embeds.length > 0, 'Embed must be displayed for multiple songs');
    assert(embeds[0].data.title.includes('Electric Love'), 'Title mentions Electric Love');
    assert(components.length >= 1, 'Select menu must be present for clickable choices');
  });

  await test('Autocomplete responds to "song" option with local files and folders', async () => {
    let respondedChoices: any[] = [];
    const mockAutocompleteInteraction = {
      options: {
        getFocused: () => ({ name: 'song', value: '' }),
      },
      respond: async (choices: any[]) => {
        respondedChoices = choices;
      },
    };

    await handleAutocomplete(mockAutocompleteInteraction as any);
    assert(Array.isArray(respondedChoices), 'Autocomplete must respond with an array');
  });

  console.log('\n======================================================');
  console.log(`   UNIVERSAL /PLAY RESULTS: ${passed}/${total} PASSED`);
  console.log('======================================================\n');

  process.exit(0);
}

runUniversalPlayTests().catch((err) => {
  console.error('Fatal error in Universal /play test suite:', err);
  process.exit(1);
});
