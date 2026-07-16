import { useEffect } from 'react';

export const SITE_NAME = 'SuperVibe';
export const DEFAULT_TITLE = `${SITE_NAME} — Build full-stack apps from a single prompt`;
export const DEFAULT_DESCRIPTION =
	'SuperVibe turns a single prompt into a deployed, full-stack app. Describe what you want, watch it get built, then iterate and ship.';

interface UsePageMetaOptions {
	/** Page-specific title. Rendered as "{title} · SuperVibe". Omit to fall back to the site default. */
	title?: string;
	/** Page-specific meta description. Omit to fall back to the site default. */
	description?: string;
}

function setMetaDescription(content: string) {
	let tag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
	if (!tag) {
		tag = document.createElement('meta');
		tag.name = 'description';
		document.head.appendChild(tag);
	}
	tag.content = content;
}

/**
 * Sets the document title and meta description for the current route.
 * Falls back to the site defaults so a page that forgets to pass a
 * title/description never inherits a stale value from the previous route.
 */
export function usePageMeta({ title, description }: UsePageMetaOptions = {}) {
	useEffect(() => {
		document.title = title ? `${title} · ${SITE_NAME}` : DEFAULT_TITLE;
		setMetaDescription(description || DEFAULT_DESCRIPTION);
	}, [title, description]);
}
