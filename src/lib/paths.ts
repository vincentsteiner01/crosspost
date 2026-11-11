// Links that keep working when the site lives in a sub-folder (GitHub Pages
// serves a project at https://<name>.github.io/<repository>/).
export const BASE = import.meta.env.BASE_URL || '/';
export const url = (path: string) => BASE + path.replace(/^\//, '');
export const absoluteUrl = (path: string) => location.origin + url(path);
