// More output than the runner keeps of one file, so it reports how much it dropped. At 512 MiB the
// whole could not be joined into one string, and a hung file was then named nowhere.
const line = `${'x'.repeat(1023)}\n`;
for (let i = 0; i < 20 * 1024; i++) process.stdout.write(line);
