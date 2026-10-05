import { loadDeviceFont, loadFontResources, type FontResource } from './device-fonts.ts';
import { CLASSROOM_DEVICE_FONT } from './classroom-members.ts';
import { withLoadingTimeout } from './loading-timeout.ts';

export const classroomEntryFonts: FontResource[] = [
  { family: 'Classroom Yan', url: '/classroom/fonts/classroom-yan.woff2', weight: '400' },
  { family: 'Long Cang', url: '/classroom/fonts/long-cang.woff2', weight: '400', sizeAdjust: '90%' },
  { family: 'CHAWP', url: '/classroom/fonts/chawp.woff2', weight: '400' },
  { family: 'Classroom Sans', url: '/classroom/fonts/classroom-sans.woff2', weight: '400 600' },
  { family: 'School Caveat', url: '/classroom/fonts/caveat.woff2', weight: '400' },
  { family: 'School Calendar Pen', url: '/classroom/fonts/calendar-pen.woff2', weight: '400' },
];
export const classroomEntryImages = [
  '/classroom/paper.webp', '/classroom/wood.webp', '/classroom/board.webp',
  '/classroom/board-grain.png', '/classroom/chalk-grain.png', '/classroom/paper-fiber.jpg',
  '/classroom/tablet-on.svg', '/classroom/tablet-off.svg',
  '/classroom/laptop-on.svg', '/classroom/laptop-off.svg',
  '/classroom/mouse-white.svg',
  '/classroom/chalk-cup-flat.svg', '/classroom/settings-flat.svg',
  '/classroom/calendar-entry.svg', '/classroom/folder-flat.svg',
  '/classroom/taskboard-flat.svg', '/classroom/projector-on.svg', '/classroom/projector-off.svg', '/classroom/fabric.webp',
  '/classroom/emergency-exit.svg', '/classroom/pencil-tip.svg', '/classroom/chalk/expand.svg',
];

// Retain the actual images, not just fulfilled promises: a later render must be
// able to request decoding again if the browser discarded its decoded surface.
const images = new Map<string, { image: HTMLImageElement; loaded: Promise<void> }>();
let preparing: Promise<void> | undefined;

export function loadClassroomImage(url: string) {
  if (document.baseURI) url = new URL(url, document.baseURI).href;
  let pending = images.get(url);
  if (!pending) {
    const image = new Image();
    const loaded = withLoadingTimeout(new Promise<void>((resolve, reject) => {
      image.onload = () => {
        if (!image.naturalWidth) { reject(new Error('教室图片未能加载，请重试。')); return; }
        resolve();
      };
      image.onerror = () => reject(new Error('教室图片未能加载，请重试。'));
      image.src = url;
    })).catch(error => { images.delete(url); image.src = ''; throw error; });
    pending = { image, loaded };
    images.set(url, pending);
  }
  const { image, loaded } = pending;
  return withLoadingTimeout(loaded.then(() => image.decode?.())).catch(error => {
    if (images.get(url) === pending) images.delete(url);
    throw error;
  });
}

// Both login and direct room entry wait on this shared preparation. Never cache a failed attempt.
export function prepareClassroomAssets(): Promise<void> {
  if (!preparing) {
    preparing = withLoadingTimeout(Promise.all([
      loadDeviceFont(CLASSROOM_DEVICE_FONT),
      loadFontResources(classroomEntryFonts),
      ...classroomEntryImages.map(loadClassroomImage),
    ])).then(() => undefined).catch(error => { preparing = undefined; throw error; });
  }
  return preparing;
}
