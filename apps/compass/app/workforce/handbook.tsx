import { listHandbookArticles } from "@xos/data/workforce-training";
import { HandbookScreen } from "@xos/workforce-native";
import { useState, type ReactElement } from "react";
import { useCompass } from "../../src/runtime/CompassProvider";
import { cachedRead } from "../../src/workforce/cache";
import { frameProps, useT, WorkforceGate } from "../../src/workforce/kit";
import { handbookLabels } from "../../src/workforce/labels";
import { useLoad, useWorkforce } from "../../src/workforce/runtime";

/** Handbook (Atlas knowledge.handbook): searchable, offline, mandatory reads acknowledged offline. */
function Handbook(): ReactElement {
  const t = useT();
  const { store } = useCompass();
  const wf = useWorkforce(t);
  const orgId = wf.orgId;
  const [search, setSearch] = useState("");
  const loaded = useLoad(
    orgId
      ? () =>
          cachedRead(store, `handbook:${orgId}`, () =>
            listHandbookArticles(wf.db, orgId, wf.myMembershipIds),
          )
      : null,
    [orgId, store, wf.syncTick],
  );
  const needle = search.trim().toLowerCase();
  const articles = (loaded.data ?? []).filter(
    (a) =>
      needle.length === 0 ||
      a.title.toLowerCase().includes(needle) ||
      a.body.toLowerCase().includes(needle),
  );
  return (
    <HandbookScreen
      {...frameProps(loaded)}
      labels={handbookLabels(t)}
      articles={articles}
      search={search}
      onSearch={setSearch}
      onAcknowledge={(articleId) =>
        wf.queue("acknowledge_handbook_article", { p_article_id: articleId })
      }
    />
  );
}

export default function HandbookRoute(): ReactElement {
  return (
    <WorkforceGate>
      <Handbook />
    </WorkforceGate>
  );
}
