export async function get(): Promise<() => void> {
  return new Promise((r, e) => {
    return r(() => console.log("Hey"));
  });
}
