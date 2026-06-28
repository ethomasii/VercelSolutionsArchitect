// Fans out runbook search to Confluence in addition to Neon.
// Real implementation: Confluence REST API v2
//   GET /wiki/rest/api/content/search?cql=text~"${query}" AND space="${spaceKey}"
// Merge results with Neon runbooks and re-rank by relevance score.
// Requires: CONFLUENCE_BASE_URL, CONFLUENCE_TOKEN, CONFLUENCE_SPACE_KEY env vars.
//
// This is the integration that makes Dispatch self-improving: as the team
// updates their Confluence runbooks, Dispatch automatically gets smarter
// without any redeployment or retraining.

export interface ConfluenceRunbook {
  title: string;
  content: string;
  url: string;
  source: 'confluence';
}

export async function searchRunbooks(
  query: string,
  _failureType: string
): Promise<ConfluenceRunbook[]> {
  if (!process.env.CONFLUENCE_BASE_URL) {
    return [];
  }

  // TODO: Replace with real Confluence API call
  // const spaceKey = process.env.CONFLUENCE_SPACE_KEY ?? 'DATA';
  // const cql = encodeURIComponent(`text~"${query}" AND space="${spaceKey}" AND type=page`);
  // const response = await fetch(
  //   `${process.env.CONFLUENCE_BASE_URL}/wiki/rest/api/content/search?cql=${cql}&expand=body.storage`,
  //   { headers: { Authorization: `Bearer ${process.env.CONFLUENCE_TOKEN}` } }
  // );
  // const data = await response.json();
  // return data.results.map((page: ConfluencePage) => ({
  //   title: page.title,
  //   content: page.body.storage.value,
  //   url: `${process.env.CONFLUENCE_BASE_URL}/wiki${page._links.webui}`,
  //   source: 'confluence' as const,
  // }));

  return [];
}
