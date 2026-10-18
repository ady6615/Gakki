import { cleanTrackMetadata, LrcLibLyricsProvider } from '@gakki/core';

async function run() {
  console.log('Testing cleanTrackMetadata:');

  const testCases = [
    { title: 'Alan Walker - Faded (Official Music Video)', artist: undefined },
    { title: 'Queen - Bohemian Rhapsody (Remastered 2011).flac', artist: 'Queen' },
    { title: 'Rick Astley - Never Gonna Give You Up [Official Video]', artist: undefined },
    { title: '01. Faded.mp3', artist: 'Alan Walker' },
  ];

  for (const tc of testCases) {
    const cleaned = cleanTrackMetadata(tc as any);
    console.log(`Original: "${tc.title}" | Artist: "${tc.artist || ''}"`);
    console.log(` -> Title: "${cleaned.title}", Artist: "${cleaned.artist}", Query: "${cleaned.searchQuery}"\n`);
  }

  console.log('Testing LrcLibLyricsProvider with YouTube title...');
  const provider = new LrcLibLyricsProvider();
  const res = await provider.search({
    title: 'Alan Walker - Faded (Official Music Video)',
  });

  if (!res) {
    console.error('FAILED: No lyrics returned for Alan Walker - Faded');
    process.exit(1);
  }

  console.log('✓ Resolved lyrics successfully!');
  console.log(`  Provider: ${res.providerName}`);
  console.log(`  Synced: ${res.isSynced}`);
  console.log(`  Lines count: ${res.syncedLyrics?.length || 0}`);
  console.log(`  Confidence: ${res.confidence}`);
  console.log(`  Preview: ${res.plainLyrics.slice(0, 80).replace(/\n/g, ' ')}...`);
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
