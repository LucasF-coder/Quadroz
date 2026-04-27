const { db } = require('../server/db');

// Lista expandida de termos úteis para FILTROS
const keepList = [
  // Gêneros principais
  'action', 'adventure', 'comedy', 'drama', 'fantasy', 'horror', 'romance', 
  'sci-fi', 'sci fi', 'slice of life', 'mystery', 'thriller', 'sports',
  'music', 'historical', 'supernatural', 'martial arts', 'school life', 'harem',
  'shounen', 'shoujo', 'seinen', 'josei', 'ecchi', 'hentai',
  'yaoi', 'yuri', 'shounen ai', 'shoujo ai', 
  'demons', 'angels', 'vampires', 'werewolves', 'magic', 'witches', 'wizards',
  'isekai', 'reincarnation', 'transmigration',
  'monsters', 'robots', 'cyborgs', 'aliens', 'ghosts', 'zombies', 'gods',
  'warriors', 'samurai', 'ninjas', 'knights', 'fairies', 'elves', 'dwarves',
  'dragons', 'mermaids', 'mythical',
  'gym', 'workplace', 'office', 'police', 'military', 'army',
  'cooking', 'food', 'restaurant', 'bakery',
  'animals', 'cats', 'dogs', 'birds', 'foxes', 'wolves', 'bears',
  'rabbits', 'horses', 'cows', 'sheep', 'chicken',
  'furry', 'anthro', 'anthro au',
  'yandere', 'tsundere', 'kuudere',
  'trap', 'femboy', 'crossdressing', 'gender bend', 'gender changer',
  'harem', 'reverse harem', 'love triangle',
  'bdsm', 'bondage', 'domination', 'submission',
  'anal', 'vaginal', 'oral', 'threesome', 'group', 'group sex',
  'creampie', 'blowjob', 'handjob', 'paizuri',
  'incest', 'rape', 'non-con', 'cheating', 'cuckold',
  'cute', 'fluffy', 'wholesome', 'heartwarming',
  'dark', 'gore', 'violence', 'blood',
  'sad', 'depression', 'psychological', 'tragedy',
  'parody', 'gag',
  'power fantasy', 'overpowered', 'op mc',
  'gaming', 'video games', 'esports',
  'idol', 'band', 'singer',
  'art', 'drawing', 'webcomic',
  'doujinshi', 'one shot', 'ongoing', 'completed',
  'translated', 'scanlation',
  // Adicionais úteis
  'monster girls', 'magical girls', 'shoujo ai', 'bl', 'gl',
  'time travel', 'time loop', 'time stop',
  'virtual reality', 'vr', 'game', 'games',
  'full color', 'color', 'colored',
  'based on novel', 'based on game', 'based on anime', 'based on manga',
  'original', 'adaptation', 'spin-off', 'spin off',
  '4 koma', '4koma', 'yonkoma',
  'long strip', 'webtoon', 'manhwa',
  'found family', 'chosen family',
  'age gap', 'milf', 'teen', 'shotacon', 'lolicon',
  'netorare', 'netori', 'cuckolding',
  'smut', 'erotic',
  'art book', 'artbook', 'sketch',
  'fan fiction', 'fanfic', 'fan art', 'fan colored',
  'censored', 'uncensored',
  'multiplayer', 'mmo', 'rpg',
  'award winning', 'bestseller',
  'classic', 'popular',
  'magic school', 'academy', 'university', 'college',
  'romantic comedy', 'romcom',
  'dark fantasy', 'urban fantasy',
  'cyberpunk', 'steampunk', 'dieselpunk',
  'isekai', 'another world', 'other world',
  'adventure', 'quest', 'journey',
  'humor', 'funny',
  'emotional',
  'scary',
  'detective', 'investigation',
  'suspense', 'suspenseful',
  'mind break', 'manipulation',
  'fight', 'fighting', 'battle',
  'athlete', 'tournament',
  'daily life', 'everyday',
  'period', 'feudal', 'medieval',
  'paranormal', 'occult',
  // Em português
  'action', 'action e aventura', 'comedy', 'drama', 'fantasia', 'terror', 'romance',
  'sci-fi', 'ficcao', 'mystery', 'sports',
  'music', 'historical', 'supernatural', 'martial arts', 'school life', 'harem',
  'demônios', 'angels', 'vampires', 'lobos', 'magic', 'witches', 'wizards',
  'monsters', 'robos', 'ciborgs', 'alienigenas', 'fantasmas', 'zumbis', 'gods',
  'warriors', 'samurais', 'ninjas', 'knights', 'fairies', 'elfos', 'dragons',
  'mermaids', 'mitico',
  'academy', 'school', 'universidade', 'work', 'escritorio',
  'cooking', 'comida', 'restaurante',
  'animals', 'cats', 'dogs', 'aves', 'foxes', 'bears',
  'harém reverso', 'triangulo amoroso',
  'bondage', 'dominaction', 'submissao',
  'tresome',
  'fofo', 'fofura', 'fofinho',
  'blood',
  'psychological', 'sad',
  'poderoso', 'sobrepoderoso',
  'games', 'games videos',
  'banda', 'cantor',
  'art', 'drawing', 'webcomic',
  'doujinshi', 'ongoing', 'completed',
  'translated',
  'time travel', 'loop temporal',
  'realidade virtual',
  'full color', 'colored',
  'familia encontrada',
  'superpowers', 'poderes',
  'daily life',
  'action aventura', 'comedy romantica'
];

const keepSet = new Set(keepList.map(k => k.toLowerCase().trim()));

function isUsefulFilter(name) {
  const lower = name.toLowerCase().trim();
  return keepSet.has(lower);
}

function isJunk(name) {
  const lower = name.toLowerCase().trim();
  
  if (lower.length > 40 && !isUsefulFilter(name)) return true;
  if (/\d{4}/.test(lower) && !/^(19|20)\d{2}$/.test(lower)) return true;
  if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/.test(name) && !isUsefulFilter(name)) return true;
  if (/[!@#$%^&*\(\)\[\]{}|;:'"<>,.\/\\?_~`\-]{2,}/i.test(lower)) return true;
  if (/^\d+$/.test(lower)) return true;
  if (!isUsefulFilter(name) && lower.length < 3) return true;
  
  return false;
}

const allCategories = db.prepare('SELECT id, name FROM categories').all();
const useful = allCategories.filter(c => isUsefulFilter(c.name));
const junk = allCategories.filter(c => !isUsefulFilter(c.name) && isJunk(c.name));

console.log('Total categorias:', allCategories.length);
console.log('Categorias úteis:', useful.length);
console.log('Categorias irrelevantes:', junk.length);
console.log('');
console.log('Exemplos de úteis:');
useful.slice(0, 30).forEach(c => console.log('  +', c.name));
console.log('');
console.log('Exemplos de irrelevantes:');
junk.slice(0, 30).forEach(c => console.log('  -', c.name));

if (junk.length > 0) {
  const ids = junk.map(c => c.id);
  db.prepare('DELETE FROM manga_categories WHERE category_id IN (' + ids.join(',') + ')').run();
  db.prepare('DELETE FROM categories WHERE id IN (' + ids.join(',') + ')').run();
  console.log('');
  console.log('Removido! Categorias restantes:', db.prepare('SELECT COUNT(*) as total FROM categories').get().total);
}