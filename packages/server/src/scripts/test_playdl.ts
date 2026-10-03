import play from 'play-dl';

async function testTracks() {
  const clientId = await play.getFreeClientID();
  await play.setToken({ soundcloud: { client_id: clientId } });

  const urls = [
    'https://soundcloud.com/nocopyrightsounds/cartoon-on-on-feat-daniel-levi-ncs-release',
    'https://soundcloud.com/alanwalker/faded',
    'https://soundcloud.com/tobuofficial/candyland',
    'https://soundcloud.com/mr_kitty/after-dark',
  ];

  for (const url of urls) {
    try {
      console.log('\nTesting:', url);
      const info = await play.soundcloud(url);
      console.log('  Name:', info.name);
      console.log('  Duration:', info.durationInSec);
      const st = await play.stream_from_info(info);
      console.log('  SUCCESS! Stream type:', st.type, 'Stream is streamable!');
    } catch (err: any) {
      console.log('  FAILED:', err.message);
    }
  }
}

testTracks();
