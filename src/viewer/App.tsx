// The viewer's layout (design reference §6.2): a header over three resizable panes, the review
// outline, the views (graph, guided review and files) and the detail pane. Every string from the
// repository or the plan is rendered as React text, never as HTML (spec invariant 6).
import { useMemo } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { LoadResult } from './data.ts';
import { Detail } from './Detail.tsx';
import { Header } from './Header.tsx';
import { buildModel } from './model.ts';
import { Outline } from './Outline.tsx';
import { ReviewProvider } from './state.tsx';
import { Views } from './Views.tsx';

export function App({ result }: { result: LoadResult }) {
  const model = useMemo(() => (result.ok ? buildModel(result.data) : null), [result]);
  if (model === null) {
    return (
      <main className="load-error">
        <h1>This review can’t be shown</h1>
        <pre>{result.ok ? '' : result.error}</pre>
        <p>Regenerate it with the same version of better-code-review that opens it.</p>
      </main>
    );
  }
  return (
    <ReviewProvider model={model}>
      <div className="app">
        <Header />
        <Group className="panes" orientation="horizontal">
          <Panel id="outline" defaultSize="22" minSize="12">
            <Outline />
          </Panel>
          <Separator className="separator" />
          <Panel id="views" defaultSize="48" minSize="20">
            <Views />
          </Panel>
          <Separator className="separator" />
          <Panel id="detail" defaultSize="30" minSize="15">
            <Detail />
          </Panel>
        </Group>
      </div>
    </ReviewProvider>
  );
}
