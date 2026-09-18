/**
 * In-page helpers for the EditRail NVDA journeys.
 *
 * `openNewPost` in helpers.js injects this file into the editor page with
 * `page.addScriptTag`. It runs in the page, so it can use `wp.data` and
 * `wp.apiFetch` directly. Keep it small: the journeys build their state
 * through Playwright and read it back with `wp.data`.
 */
window.__qa = {
  /**
   * Delete the draft the editor created when the journey opened a new post.
   *
   * Returns the post ID that was deleted, or false when there was no post
   * or the request failed.
   */
  async deleteCurrentPost() {
    try {
      const id = wp.data.select('core/editor').getCurrentPostId();
      if (!id) return false;
      await wp.apiFetch({ path: '/wp/v2/posts/' + id + '?force=true', method: 'DELETE' });
      return id;
    } catch (e) {
      return false;
    }
  },
};
