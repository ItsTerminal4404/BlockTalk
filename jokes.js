(function () {
    const setups = [
        ['Why did the creeper bring a map?', 'It wanted to find its way out of a blast.'],
        ['Why did the skeleton skip the party?', 'It had no body to go with.'],
        ['Why did the block go to school?', 'It wanted to improve its solid reasoning.'],
        ['Why did the pixel bring an umbrella?', 'It heard there was a 100% chance of rain pixels.'],
        ['Why did the redstone dust get promoted?', 'It had excellent connections.'],
        ['Why did the chicken cross the chunk border?', 'To load the other side.'],
        ['Why did the pickaxe take a break?', 'It was feeling a little chipped.'],
        ['Why did the torch get invited everywhere?', 'It really knew how to light up a room.'],
        ['Why did the cow start coding?', 'It wanted to make better moo-ves.'],
        ['Why did the diamond stay calm?', 'It knew pressure makes it stronger.'],
        ['Why did the minecart apply for a job?', 'It wanted to get back on track.'],
        ['Why did the zombie open a bakery?', 'It was great at making dough rise from the dead.'],
        ['Why did the grass block tell a secret?', 'It needed to get something off its chest.'],
        ['Why did the enderman carry a ladder?', 'It wanted to reach a higher dimension.'],
        ['Why did the shovel join the band?', 'It was good at digging the beat.'],
        ['Why did the furnace get detention?', 'It kept raising the temperature.'],
        ['Why did the villager become a comedian?', 'Its trades were always a good deal.'],
        ['Why did the sheep open a salon?', 'It was an expert at wool styling.'],
        ['Why did the server wear armor?', 'It wanted better protection from bad packets.'],
        ['Why did the cape get invited to the launch?', 'It always made a good entrance.']
    ];
    const tags = [
        '', ' (Definitely true in at least one chunk.)', ' (No blocks were harmed.)',
        ' (The sheep approved.)', ' (Please laugh responsibly.)', ' (That is the whole punchline.)',
        ' (Works best with subtitles on.)', ' (Tested by one very amused villager.)',
        ' (May require a little imagination.)', ' (A classic from the loading screen.)',
        ' (The punchline is server-friendly.)', ' (No rare items required.)',
        ' (Even the creeper giggled.)', ' (That joke has excellent latency.)',
        ' (Insert rimshot made of note blocks.)', ' (Now available in 64 pixels.)',
        ' (The enderman says it is funny.)', ' (Approved for peaceful mode.)',
        ' (A joke with strong durability.)', ' (Please do not throw a potion.)',
        ' (The punchline spawned nearby.)', ' (No villagers were startled.)',
        ' (Runs on renewable humor.)', ' (That was a critical hit.)',
        ' (Keep it between the chunks.)', ' (The laugh is client-side.)',
        ' (Compatible with most editions.)', ' (No resource pack needed.)',
        ' (The joke is still loading.)', ' (One giggle per tick.)',
        ' (Crafted with four smiles.)', ' (A very square setup.)',
        ' (The punchline has been enchanted.)', ' (No creepers were invited.)',
        ' (The server log says: funny.)', ' (That one dropped rare loot.)',
        ' (A small joke with a big hitbox.)', ' (The punchline is unbreakable.)',
        ' (Mined fresh from the joke bank.)', ' (The comedy chunk is loaded.)',
        ' (A certified block-comedy classic.)', ' (The laugh travels at redstone speed.)',
        ' (No command blocks required.)', ' (The joke survived the update.)',
        ' (A little lag makes it funnier.)', ' (The punchline is not flammable.)',
        ' (The joke has feather falling.)', ' (A clean joke for every biome.)',
        ' (The laugh is set to maximum render distance.)', ' (The credits roll in cobblestone.)'
    ];
    window.BlockTalkPresetJokes = Array.from({ length: 1000 }, (_, index) => {
        const [setup, punchline] = setups[index % setups.length];
        return `${setup} ${punchline}${tags[Math.floor(index / setups.length)]}`;
    });
})();
