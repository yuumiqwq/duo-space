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
];

const images = new Map<string, Promise<void>>();
let preparing: Promise<void> | undefined;

function loadImage(url: string) {
  let pending = images.get(url);
  if (!pending) {
    const image = new Image();
    pending = withLoadingTimeout(new Promise<void>((resolve, reject) => {
      image.onload = () => {
        if (!image.naturalWidth) { reject(new Error('教室图片未能加载，请重试。')); return; }
        void (image.decode ? image.decode() : Promise.resolve()).then(() => resolve(), reject);
      };
      image.onerror = () => reject(new Error('教室图片未能加载，请重试。'));
      image.src = url;
    })).catch(error => { images.delete(url); image.src = ''; throw error; });
    images.set(url, pending);
  }
  return pending;
}

// Both login and direct room entry wait on this shared preparation. Never cache a failed attempt.
export function prepareClassroomAssets(): Promise<void> {
  if (!preparing) {
    preparing = withLoadingTimeout(Promise.all([
      loadDeviceFont(CLASSROOM_DEVICE_FONT),
      loadFontResources(classroomEntryFonts),
      ...classroomEntryImages.map(loadImage),
    ])).then(() => undefined).catch(error => { preparing = undefined; throw error; });
  }
  return preparing;
}
