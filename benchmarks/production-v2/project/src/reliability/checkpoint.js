export async function resumeWork(items, _checkpoint, processItem) {
  const results = [];
  for (let index = 0; index < items.length; index += 1) results.push(await processItem(items[index], index));
  return { nextIndex: items.length, results };
}
