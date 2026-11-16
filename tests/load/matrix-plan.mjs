export function matrixStages(cli, availableScreens) {
  const counts = String(cli.devices ?? '10,25,50,100,200').split(',').map(Number);
  if (!counts.length || counts.length > 30 || counts.some((n, i) => !Number.isSafeInteger(n) || n < 1 || n > availableScreens || (i > 0 && n <= counts[i - 1]))) {
    throw new Error('devices must be strictly increasing distinct screen counts within the fixture capacity.');
  }
  const seconds = Number(cli['stage-seconds'] ?? 600);
  const warmup = Number(cli['warmup-seconds'] ?? 180);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 86400 || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 3600) {
    throw new Error('stage-seconds must be 30..86400; warmup-seconds must be 0..3600 (whole seconds).');
  }
  return [
    ...(warmup ? [{ name: 'warmup', screens: counts[0], seconds: warmup }] : []),
    ...counts.map(screens => ({ name: `devices${screens}`, screens, seconds })),
  ];
}
