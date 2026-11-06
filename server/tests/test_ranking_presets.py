"""榜单筛选预设接口的响应契约与隔离测试。"""

from tests.conftest import register_client


def test_ranking_presets_are_enveloped_and_client_scoped(client):
    first = register_client(client, "preset-client-a")
    second = register_client(client, "preset-client-b")

    created = client.put(
        "/v1/ranking-presets",
        json={"name": "墨西哥日榜", "query_json": {"region": "MX", "rankingVariant": "top-sold"}},
        headers=first["headers"],
    )
    assert created.status_code == 200
    body = created.json()
    assert body["error"] is None
    assert body["data"]["name"] == "墨西哥日榜"

    listed = client.get("/v1/ranking-presets", headers=first["headers"])
    assert listed.status_code == 200
    assert listed.json()["error"] is None
    assert [item["name"] for item in listed.json()["data"]["items"]] == ["墨西哥日榜"]

    other = client.get("/v1/ranking-presets", headers=second["headers"])
    assert other.status_code == 200
    assert other.json()["data"] == {"items": []}
