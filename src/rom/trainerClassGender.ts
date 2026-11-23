// The trainer classes the game treats as female when it builds trainer Pokémon PIDs.
//
// Source: pret/pokeplatinum at commit 62bdaacdca6c56a6a396f3e9911e2f922b79bba8,
// `include/data/trainer_class_genders.h` (`sTrainerClassGender`, read by `TrainerClass_Gender` in
// `src/trainer_data.c`). Class IDs are positions in `generated/trainer_classes.txt` at the same commit,
// counting from 0. These are the GENDER_FEMALE entries. GENDER_NONE classes (pairs such as Young Couple)
// get the male modifier, as in the game.

export const FEMALE_TRAINER_CLASSES: ReadonlySet<number> = new Set([
  1, // Player (female)
  3, // Lass
  5, // Picnicker
  7, // Aroma Lady
  8, // Twins
  10, // Battle Girl
  13, // Cyclist (female)
  17, // Pokémon Breeder (female)
  18, // Cowgirl
  21, // Poké Fan (female)
  22, // Poké Kid
  25, // Ace Trainer (female)
  26, // Waitress
  30, // Bird Keeper
  33, // Lady
  35, // Socialite
  36, // Beauty
  40, // Pokémon Ranger (female)
  43, // Swimmer (female)
  45, // Tuber (female)
  50, // Psychic (female)
  54, // Ace Trainer, snow (female)
  56, // Skier (female)
  61, // School Kid (female)
  66, // Elite Four Bertha
  69, // Champion Cynthia
  72, // Commander Mars
  74, // Leader Gardenia
  76, // Leader Maylene
  77, // Leader Fantina
  78, // Leader Candice
  80, // Parasol Lady
  84, // Reporter
  85, // Idol
  87, // Commander Jupiter
  88, // Commander Saturn (female in the game's own table)
  89, // Galactic Grunt (female)
  90, // Cheryl
  92, // Marley
  94, // Mira
  96, // Diamond/Pearl player (female)
  98, // Maid
  99, // Hall Matron
  101, // Arcade Star
  104, // Diamond/Pearl player (female), second entry
]);
