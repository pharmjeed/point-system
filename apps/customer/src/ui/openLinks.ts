/**
 * Opening things outside the app: «فتح في الخرائط» (C-07/C-08; the platform's maps app, then the web map) and the
 * C-19 links (support, terms, privacy). Returns false when nothing could be opened, so the screen can say so.
 */
import { Linking, Platform } from 'react-native';
import { mapsUrl, webMapsUrl } from '../features/locations';

async function tryOpen(url: string | null): Promise<boolean> {
  if (!url) return false;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

export async function openInMaps(loc: {
  lat: number | null;
  lng: number | null;
  name: string;
  address?: string | null;
}): Promise<boolean> {
  return (await tryOpen(mapsUrl(Platform.OS, loc))) || tryOpen(webMapsUrl(loc));
}

export const openLink = (url: string): Promise<boolean> => tryOpen(url);
