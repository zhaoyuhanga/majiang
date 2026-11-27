export function actionStillMatchesSnapshot(pending, snap) {
  if (!pending || !snap || snap.state !== 'playing' || pending.roundNo !== snap.roundNo) return false;
  const game = snap.game;
  const options = game?.options;
  if (pending.phase === 'claim') return options?.phase === 'claim';
  if (pending.phase === 'discard') {
    if (options?.phase !== 'discard' || game.turn !== snap.mySeat) return false;
    if (pending.type === 'tingHint') return options.tingHintChecked === true;
    return pending.type !== 'swapDraw' || pending.drawSerial === game.drawSerial;
  }
  return false;
}
