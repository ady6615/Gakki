/**
 * Intelligent Music Genre Classification and Inference Utility.
 */

const GENRE_RULES: Array<{ genre: string; patterns: RegExp[] }> = [
  {
    genre: 'Lo-Fi / Chill',
    patterns: [/\blo-?fi\b/i, /\bchill(hop|out|step)?\b/i, /\bsleep\b/i, /\bstudy beats\b/i, /\brelaxing\b/i],
  },
  {
    genre: 'Hip-Hop / Rap',
    patterns: [
      /\bhip-?hop\b/i,
      /\brap(per)?\b/i,
      /\btrap\b/i,
      /\bphonk\b/i,
      /\bdrill\b/i,
      /\bboom bap\b/i,
      /\bfreestyle\b/i,
      /\bcypher\b/i,
      /\bdrake\b/i,
      /\bkendrick\b/i,
      /\beminem\b/i,
      /\btravisscott\b/i,
    ],
  },
  {
    genre: 'Rock / Metal',
    patterns: [
      /\brock\b/i,
      /\bmetal(core|head)?\b/i,
      /\bpunk\b/i,
      /\bgrunge\b/i,
      /\balternative rock\b/i,
      /\bhard rock\b/i,
      /\bheavy metal\b/i,
      /\bac\/dc\b/i,
      /\bmetallica\b/i,
      /\bnirvana\b/i,
      /\blinkin park\b/i,
      /\bradiohead\b/i,
    ],
  },
  {
    genre: 'Electronic / EDM',
    patterns: [
      /\bedm\b/i,
      /\belectro(nic|nica)?\b/i,
      /\bhouse\b/i,
      /\btechno\b/i,
      /\btrance\b/i,
      /\bdubstep\b/i,
      /\bdrum and bass\b/i,
      /\bdnb\b/i,
      /\bsynthwave\b/i,
      /\bretro wave\b/i,
      /\bfuture bass\b/i,
      /\bhardstyle\b/i,
      /\bdance\b/i,
      /\bavicii\b/i,
      /\bmartin garrix\b/i,
      /\bcalvin harris\b/i,
      /\btiesto\b/i,
      /\bzedd\b/i,
      /\balesso\b/i,
      /\bkygo\b/i,
      /\bmarshmello\b/i,
      /\bskrillex\b/i,
      /\bdaft punk\b/i,
      /\bdeadmau5\b/i,
      /\bdavid guetta\b/i,
    ],
  },
  {
    genre: 'Pop',
    patterns: [
      /\bpop\b/i,
      /\bdance pop\b/i,
      /\belectropop\b/i,
      /\btaylor swift\b/i,
      /\bdua lipa\b/i,
      /\bariana grande\b/i,
      /\bolivia rodrigo\b/i,
      /\bbillie eilish\b/i,
      /\bthe weeknd\b/i,
      /\bbruno mars\b/i,
      /\bed sheeran\b/i,
      /\bjustin bieber\b/i,
    ],
  },
  {
    genre: 'R&B / Soul',
    patterns: [/\br&b\b/i, /\brnb\b/i, /\bsoul\b/i, /\bneo-soul\b/i, /\bfunk\b/i, /\bmotown\b/i, /\bsza\b/i, /\bfrank ocean\b/i],
  },
  {
    genre: 'Anime / J-Pop / K-Pop',
    patterns: [
      /\banime\b/i,
      /\bj-?pop\b/i,
      /\bk-?pop\b/i,
      /\bopening\b/i,
      /\bending\b/i,
      /\bvocaloid\b/i,
      /\bbts\b/i,
      /\bblackpink\b/i,
      /\btwice\b/i,
      /\byoasobi\b/i,
      /\bado\b/i,
      /\beve\b/i,
      /\blisa\b/i,
      /\bkenshi yonezu\b/i,
      /\bdemon slayer\b/i,
      /\bnaruto\b/i,
      /\battack on titan\b/i,
      /\bjujutsu kaisen\b/i,
    ],
  },
  {
    genre: 'Indie / Alternative',
    patterns: [/\bindie(pop|rock)?\b/i, /\balternative\b/i, /\bshoegaze\b/i, /\bfolk\b/i, /\bacoustic\b/i],
  },
  {
    genre: 'Classical / Instrumental',
    patterns: [
      /\bclassical\b/i,
      /\borchestra(l)?\b/i,
      /\bsymphony\b/i,
      /\bpiano\b/i,
      /\bviolin\b/i,
      /\bmozart\b/i,
      /\bbeethoven\b/i,
      /\bchopin\b/i,
      /\bhans zimmer\b/i,
      /\bsoundtrack\b/i,
      /\bost\b/i,
    ],
  },
  {
    genre: 'Jazz / Blues',
    patterns: [/\bjazz\b/i, /\bblues\b/i, /\bbossa nova\b/i, /\bsaxophone\b/i, /\bmiles davis\b/i],
  },
  {
    genre: 'Latin / Reggaeton',
    patterns: [/\blatin\b/i, /\breggaeton\b/i, /\bsalsa\b/i, /\bbachata\b/i, /\bbad bunny\b/i, /\bj balvin\b/i],
  },
];

/**
 * Infer the most likely musical genre given track metadata or search text.
 */
export function inferGenre(metadata: {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  query?: string | null;
}): string {
  if (metadata.genre && metadata.genre.trim()) {
    const raw = metadata.genre.trim();
    for (const rule of GENRE_RULES) {
      if (rule.patterns.some((p) => p.test(raw))) {
        return rule.genre;
      }
    }
    return raw;
  }

  const combined = [metadata.title, metadata.artist, metadata.album, metadata.query]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  for (const rule of GENRE_RULES) {
    if (rule.patterns.some((p) => p.test(combined))) {
      return rule.genre;
    }
  }

  return 'Pop'; // default standard genre
}
