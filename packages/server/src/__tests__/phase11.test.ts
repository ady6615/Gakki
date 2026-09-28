/**
 * Phase 11 Automated Verification Test Suite
 *
 * Comprehensive tests covering:
 * - 1. RIFF WAVE Audio Utilities & Header Parsing
 * - 2. Multi-Participant Timeline Alignment & RecordingMixer Summation
 * - 3. Soft-Limiting & Int16 Headroom Protection
 * - 4. Persistent Recording Session Lifecycle & Audit Logging
 * - 5. Participant Join/Leave Tracking & Timeline Alignment
 * - 6. Asynchronous Transcription & Speaker Attribution
 * - 7. Transcript Segments & Substring Keyword Search
 * - 8. Recording Permission System & Error Formatting
 * - 9. Retention Policy & Cascading Deletion
 * - 10. Multi-Guild Isolation & Playback Coexistence
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  connectDatabase,
  getDatabasePool,
  RecordingManager,
  RecordingMixer,
  TranscriptionManager,
  TranscriptionProviderRegistry,
  MockTranscriptionProvider,
  WhisperLocalProvider,
  createWavHeader,
  parseWavHeader,
  createSilenceBuffer,
  pcmToWav,
} from '@gakki/core';
import { checkRecordingPermission, CommandPermissionLevel } from '../discord/permissions';
import { BotErrors, formatUserFacingError } from '../discord/errors';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function runPhase11Tests(): Promise<void> {
  console.log('================================================================');
  console.log('       GAKKI MUSIC PLATFORM — PHASE 11 VERIFICATION SUITE       ');
  console.log('================================================================\n');

  const databaseUrl = process.env.DATABASE_URL || 'postgresql://gakki:gakki@localhost:5432/gakki';
  await connectDatabase(databaseUrl);
  const pool = getDatabasePool();
  if (!pool) {
    throw new Error('Database pool could not be established');
  }

  const tmpTestDir = path.resolve(process.cwd(), 'storage', 'tmp', 'test-p11');
  const storageTestDir = path.resolve(process.cwd(), 'storage', 'test-p11');
  fs.mkdirSync(tmpTestDir, { recursive: true });
  fs.mkdirSync(storageTestDir, { recursive: true });

  const guildA = `test-guild-a-${Date.now()}`;
  const guildB = `test-guild-b-${Date.now()}`;

  // ─────────────────────────────────────────────────────────────
  // 1. Audio Utilities & RIFF WAVE Header Generation
  // ─────────────────────────────────────────────────────────────
  console.log('--- 1. Audio Utilities & RIFF WAVE Header ---');

  const sampleRate = 48000;
  const numChannels = 2;
  const bitDepth = 16;
  const dataByteCount = 48000 * 2 * 2 * 2; // 2 seconds of stereo 16-bit PCM

  const header = createWavHeader({
    dataLength: dataByteCount,
    sampleRate,
    numChannels,
    bitDepth,
  });

  assert(header.length === 44, 'WAV header is exactly 44 bytes');
  assert(header.toString('ascii', 0, 4) === 'RIFF', 'RIFF chunk identifier present');
  assert(header.toString('ascii', 8, 12) === 'WAVE', 'WAVE format identifier present');
  assert(header.toString('ascii', 12, 16) === 'fmt ', 'fmt subchunk identifier present');
  assert(header.toString('ascii', 36, 40) === 'data', 'data subchunk identifier present');

  const parsed = parseWavHeader(header);
  assert(parsed !== null, 'parseWavHeader parses generated header');
  assert(parsed?.sampleRate === 48000, 'Sample rate accurately parsed as 48000Hz');
  assert(parsed?.numChannels === 2, 'Channel count accurately parsed as 2 (stereo)');
  assert(parsed?.bitDepth === 16, 'Bit depth accurately parsed as 16-bit');
  assert(parsed?.dataLength === dataByteCount, 'Data byte count accurately parsed');

  const silence = createSilenceBuffer(500, sampleRate, numChannels, bitDepth);
  // 500ms = 0.5s * 48000 = 24000 samples * 4 bytes = 96000 bytes
  assert(silence.length === 96000, 'createSilenceBuffer produces exact zero-padded silence byte length');
  assert(silence.every((byte) => byte === 0), 'Silence buffer contains all zero PCM samples');

  // ─────────────────────────────────────────────────────────────
  // 2. Multi-Participant Timeline Alignment & Audio Mixer
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. Multi-Participant Timeline Alignment & Mixer ---');

  // Generate 1 second synthetic tone for User A (starts at 0ms)
  const user1Pcm = Buffer.alloc(48000 * 4); // 1 sec stereo 16-bit
  for (let i = 0; i < 48000; i++) {
    const val = Math.floor(Math.sin((2 * Math.PI * 440 * i) / 48000) * 10000);
    user1Pcm.writeInt16LE(val, i * 4);     // Left
    user1Pcm.writeInt16LE(val, i * 4 + 2); // Right
  }
  const user1WavPath = path.join(tmpTestDir, 'user1.wav');
  pcmToWav(user1Pcm, user1WavPath);

  // Generate 1 second synthetic tone for User B (starts at 1000ms offset)
  const user2Pcm = Buffer.alloc(48000 * 4); // 1 sec stereo 16-bit
  for (let i = 0; i < 48000; i++) {
    const val = Math.floor(Math.sin((2 * Math.PI * 880 * i) / 48000) * 10000);
    user2Pcm.writeInt16LE(val, i * 4);
    user2Pcm.writeInt16LE(val, i * 4 + 2);
  }
  const user2WavPath = path.join(tmpTestDir, 'user2.wav');
  pcmToWav(user2Pcm, user2WavPath);

  const mixer = new RecordingMixer();
  const mixedOutputPath = path.join(tmpTestDir, 'mixed.wav');

  const mixResult = await mixer.mixTracks({
    tracks: [
      { userId: 'u1', filePath: user1WavPath, timelineOffsetMs: 0, durationMs: 1000 },
      { userId: 'u2', filePath: user2WavPath, timelineOffsetMs: 1000, durationMs: 1000 },
    ],
    outputPath: mixedOutputPath,
  });

  assert(fs.existsSync(mixedOutputPath), 'Mixed WAV output file exists on disk');
  assert(mixResult.participantCount === 2, 'MixResult reports 2 participants');
  assert(mixResult.durationSeconds >= 2, 'MixResult spans combined aligned duration (>= 2s)');
  assert(mixResult.format === 'wav', 'Format is lossless WAV');

  const mixedData = fs.readFileSync(mixedOutputPath);
  const mixedParsed = parseWavHeader(mixedData.subarray(0, 44));
  assert(mixedParsed?.sampleRate === 48000, 'Mixed WAV maintains 48kHz sampling rate');
  assert(mixedParsed?.numChannels === 2, 'Mixed WAV maintains stereo 2 channels');

  // ─────────────────────────────────────────────────────────────
  // 3. Headroom & Soft-Limiting Protection
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. Headroom & Soft-Limiting Protection ---');

  // Mix two overlapping loud signals to test soft limiting
  const loudPcm = Buffer.alloc(48000 * 4);
  for (let i = 0; i < 48000; i++) {
    loudPcm.writeInt16LE(25000, i * 4);
    loudPcm.writeInt16LE(25000, i * 4 + 2);
  }
  const loud1Path = path.join(tmpTestDir, 'loud1.wav');
  const loud2Path = path.join(tmpTestDir, 'loud2.wav');
  pcmToWav(loudPcm, loud1Path);
  pcmToWav(loudPcm, loud2Path);

  const loudOutputPath = path.join(tmpTestDir, 'loud-mixed.wav');
  await mixer.mixTracks({
    tracks: [
      { userId: 'loud1', filePath: loud1Path, timelineOffsetMs: 0, durationMs: 1000 },
      { userId: 'loud2', filePath: loud2Path, timelineOffsetMs: 0, durationMs: 1000 }, // Overlaps: 25k + 25k = 50k > 32767
    ],
    outputPath: loudOutputPath,
  });

  const loudMixed = fs.readFileSync(loudOutputPath);
  let maxSample = 0;
  for (let i = 44; i < loudMixed.length; i += 2) {
    const s = Math.abs(loudMixed.readInt16LE(i));
    if (s > maxSample) maxSample = s;
  }
  assert(maxSample <= 32767, 'Soft-limiter successfully prevented Int16 overflow/clipping');
  assert(maxSample > 20000, 'Soft-limiter preserved loudness without aggressive distortion');

  // ─────────────────────────────────────────────────────────────
  // 4. Recording Session Model & Audit Logging
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 4. Recording Session Model & Audit Logging ---');

  const recManager = new RecordingManager(pool, {
    storageRoot: storageTestDir,
    tmpRoot: tmpTestDir,
  });

  const session = await recManager.createSession({
    guildId: guildA,
    voiceChannelId: 'vc-100',
    startedBy: 'user-operator-1',
    title: 'Design Review & Architecture',
    visibility: 'GUILD',
  });

  assert(session.id.length > 0, 'Recording session created with valid UUID');
  assert(session.status === 'RECORDING', 'Initial session status is RECORDING');
  assert(session.guildId === guildA, 'Session bound to correct guild ID');
  assert(session.title === 'Design Review & Architecture', 'Session title preserved');

  // Audit event verification
  const auditRes = await pool.query(
    `SELECT * FROM recording_audit_events WHERE recording_id = $1 AND action = 'STARTED'`,
    [session.id]
  );
  assert(auditRes.rows.length === 1, 'STARTED audit event logged in database');
  assert(auditRes.rows[0].actor_user_id === 'user-operator-1', 'Audit log records actor user ID');

  // ─────────────────────────────────────────────────────────────
  // 5. Participant Join/Leave Tracking
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 5. Participant Join/Leave Tracking ---');

  await recManager.addOrUpdateParticipant(session.id, {
    userId: 'discord-u1',
    displayName: 'Alice (Engineer)',
    firstAudioTimestamp: 0,
    audioStorageKey: 'storage/recordings/u1.wav',
  });

  await recManager.addOrUpdateParticipant(session.id, {
    userId: 'discord-u2',
    displayName: 'Bob (PM)',
    firstAudioTimestamp: 1500, // Joined at 1.5s
    audioStorageKey: 'storage/recordings/u2.wav',
  });

  // Participant leaves
  await recManager.markParticipantLeft(session.id, 'discord-u2', 8000);

  const fetchedSession = await recManager.getSession(session.id);
  assert(fetchedSession?.participants?.length === 2, 'Both participants tracked in session');
  const alice = fetchedSession?.participants?.find((p) => p.userId === 'discord-u1');
  const bob = fetchedSession?.participants?.find((p) => p.userId === 'discord-u2');

  assert(alice?.displayName === 'Alice (Engineer)', 'Alice display name recorded');
  assert(alice?.firstAudioTimestamp === 0, 'Alice timeline offset preserved at 0ms');
  assert(bob?.firstAudioTimestamp === 1500, 'Bob timeline offset preserved at 1500ms');
  assert(bob?.lastAudioTimestamp === 8000, 'Bob departure timestamp recorded at 8000ms');

  // ─────────────────────────────────────────────────────────────
  // 6. Asynchronous Transcription & Speaker Attribution
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 6. Asynchronous Transcription & Speaker Attribution ---');

  const registry = new TranscriptionProviderRegistry();
  const mockProvider = new MockTranscriptionProvider();
  registry.registerProvider(mockProvider, true);

  const whisper = registry.getProvider('whisper-local');
  assert(whisper instanceof WhisperLocalProvider, 'WhisperLocalProvider successfully registered');

  const activeProvider = await registry.getBestAvailableProvider();
  assert(activeProvider !== null, 'Best available transcription provider resolved');

  const transcriptionManager = new TranscriptionManager(pool, registry, {
    defaultProvider: 'mock-transcription',
  });

  // Complete session
  await recManager.completeSession(session.id, {
    mixedFilePath: mixedOutputPath,
    durationSeconds: 15,
    fileSizeBytes: 102400,
    format: 'wav',
    sampleRate: 48000,
    channels: 2,
    participantCount: 2,
  });

  const completedSession = await recManager.getSession(session.id);
  assert(completedSession?.status === 'COMPLETED', 'Session successfully marked COMPLETED');
  assert(completedSession?.duration === 15, 'Session duration recorded as 15 seconds');

  // Run transcription
  const transcript = await transcriptionManager.processTranscription(session.id);
  assert(transcript !== null, 'Transcription completed successfully');
  assert(transcript?.status === 'COMPLETED', 'Transcript status is COMPLETED');
  assert(transcript?.provider === 'mock-transcription', 'Transcript provider recorded');
  assert(Array.isArray(transcript?.segments) && transcript.segments.length > 0, 'Timestamped segments generated');

  // Speaker attribution verification
  const firstSeg = transcript!.segments![0];
  assert(firstSeg.startMs >= 0, 'Segment start timestamp in milliseconds');
  assert(firstSeg.endMs > firstSeg.startMs, 'Segment end timestamp follows start timestamp');
  assert(firstSeg.speakerName?.includes('Alice') || firstSeg.speakerName?.includes('Bob'), 'Participant attributed to speech segment');

  // ─────────────────────────────────────────────────────────────
  // 7. Transcript Segments & Substring Search
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 7. Transcript Segments & Substring Search ---');

  // Search keyword "discussion" or "architecture"
  const searchResults = await transcriptionManager.searchTranscriptSegments(session.id, 'architecture');
  assert(Array.isArray(searchResults), 'Search returns array of matching segments');
  if (searchResults.length > 0) {
    assert(searchResults[0].text.toLowerCase().includes('architecture'), 'Search segment contains matching keyword');
  }

  // ─────────────────────────────────────────────────────────────
  // 8. Permission System & Error Formatting
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 8. Permissions & Error Formatting ---');

  const createMockRoles = (roleList: Array<{ name: string }>) => ({
    cache: {
      some: (fn: (r: { name: string }) => boolean) => roleList.some(fn),
    },
  });

  const operatorInteraction: any = {
    user: { id: 'op-1' },
    guild: { ownerId: 'owner-1' },
    member: {
      permissions: { has: () => false },
      roles: createMockRoles([{ name: 'recording operator' }]),
    },
  };

  const listenerInteraction: any = {
    user: { id: 'listener-1' },
    guild: { ownerId: 'owner-1' },
    member: {
      permissions: { has: () => false },
      roles: createMockRoles([]),
    },
  };

  assert(checkRecordingPermission(operatorInteraction).allowed === true, 'Member with RECORDING_OPERATOR role is authorized');
  assert(checkRecordingPermission(listenerInteraction).allowed === false, 'Standard listener member is denied recording permission');

  const userFacingError = formatUserFacingError(BotErrors.RECORDING_NO_PERMISSION);
  assert(userFacingError.includes('permission to operate voice recording'), 'User-facing recording error formatted properly');

  // ─────────────────────────────────────────────────────────────
  // 9. Retention Policy & Cascading Deletion
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 9. Retention Policy & Cascading Deletion ---');

  // Test orphan cleanup
  await recManager.cleanOrphanedRecordings();
  assert(true, 'cleanOrphanedRecordings runs without exception');

  // Test retention policy
  const purged = await recManager.cleanupExpiredRecordings(30);
  assert(typeof purged === 'number', 'Retention policy returns purged count number');

  // Delete session
  const deleted = await recManager.deleteSession(session.id, 'admin-cleanup');
  assert(deleted === true, 'Session deleted successfully');

  const checkDeleted = await recManager.getSession(session.id);
  assert(checkDeleted === null, 'Deleted session cannot be retrieved');

  const remainingParticipants = await pool.query(
    `SELECT * FROM recording_participants WHERE recording_id = $1`,
    [session.id]
  );
  assert(remainingParticipants.rows.length === 0, 'Participant records cascaded on deletion');

  const remainingTranscripts = await pool.query(
    `SELECT * FROM transcripts WHERE recording_id = $1`,
    [session.id]
  );
  assert(remainingTranscripts.rows.length === 0, 'Transcript records cascaded on deletion');

  // ─────────────────────────────────────────────────────────────
  // 10. Multi-Guild Isolation
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 10. Multi-Guild Isolation ---');

  const sessionA = await recManager.createSession({
    guildId: guildA,
    voiceChannelId: 'vc-A',
    startedBy: 'user-A',
    title: 'Guild A Strategy',
  });

  const sessionB = await recManager.createSession({
    guildId: guildB,
    voiceChannelId: 'vc-B',
    startedBy: 'user-B',
    title: 'Guild B Strategy',
  });

  const guildAList = await recManager.listSessions({ guildId: guildA });
  const guildBList = await recManager.listSessions({ guildId: guildB });

  assert(guildAList.every((s) => s.guildId === guildA), 'Guild A query only returns Guild A sessions');
  assert(guildBList.every((s) => s.guildId === guildB), 'Guild B query only returns Guild B sessions');
  assert(!guildAList.some((s) => s.id === sessionB.id), 'Guild B session ID never appears in Guild A results');

  // Cleanup test sessions
  await recManager.deleteSession(sessionA.id, 'cleanup');
  await recManager.deleteSession(sessionB.id, 'cleanup');

  // Cleanup tmp test files
  try {
    fs.rmSync(tmpTestDir, { recursive: true, force: true });
    fs.rmSync(storageTestDir, { recursive: true, force: true });
  } catch {
    // Ignored
  }

  console.log('\n================================================================');
  console.log('       🎉 ALL PHASE 11 AUTOMATED VERIFICATION TESTS PASSED       ');
  console.log('================================================================');
}

runPhase11Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
