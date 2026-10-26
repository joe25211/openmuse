export function sessionStorageKey(url: string) {
  return `openmuse.${Array.from(url, (char) => char.charCodeAt(0).toString(16).padStart(4, "0")).join("")}`;
}

/** SecureStore's minimal read/delete seam; no access key is persisted. */
export async function restoreSavedSession(
  storage: {
    getItemAsync(key: string): Promise<string | null>;
    deleteItemAsync(key: string): Promise<void>;
  },
  key: string,
  validate: (token: string) => Promise<boolean>,
): Promise<string | null> {
  const token = await storage.getItemAsync(key);
  if (!token) return null;
  if (await validate(token)) return token;
  await storage.deleteItemAsync(key);
  return null;
}
