import SoundCloud from 'soundcloud.ts';

async function testSoundCloudTs() {
  const sc = new SoundCloud();
  const testUrl = 'https://soundcloud.com/nocopyrightsounds/cartoon-on-on-feat-daniel-levi-ncs-release';
  console.log('Fetching track...');
  const track = await sc.tracks.getAlt(testUrl);
  console.log('Title:', track.title);
  console.log('Artist:', track.user?.username);
  console.log('Duration:', track.duration);

  console.log('Getting stream track...');
  const stream = await sc.util.streamTrack(testUrl);
  console.log('Stream object:', Boolean(stream));
  console.log('SUCCESS with soundcloud.ts stream!');
}

testSoundCloudTs().catch(err => console.error('Caught error:', err));
