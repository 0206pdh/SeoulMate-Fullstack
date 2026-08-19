import assert from "node:assert/strict";
import test from "node:test";

import { mapClient } from "../dist/clients/map.client.js";
import { MAX_RECOMMENDATION_SCORE, SCORE_WEIGHT } from "../dist/constants/scoreWeight.js";
import {
  defaultRoleOrder,
  requestedRolesFromCategories,
  resolvePlaceCountRange,
  resolveRequestHourKst
} from "../dist/graphs/courseRole.js";
import {
  classifyKakaoPlaceCategory,
  classifyPublicDataCategory,
  isEligibleKakaoPlaceCategory
} from "../dist/utils/publicDataCategory.js";
import { validateSignupRequest } from "../dist/validators/user.validator.js";
import { validateRecommendationNode } from "../dist/graphs/nodes/validateRecommendation.node.js";
import { parseUserRequestNode } from "../dist/graphs/nodes/parseUserRequest.node.js";

const placeCountCases = [
  [2, { min: 1, max: 2 }],
  [4, { min: 2, max: 3 }],
  [6, { min: 3, max: 4 }],
  [8, { min: 4, max: 5 }],
  [10, { min: 5, max: 6 }],
  [12, { min: 6, max: 7 }],
  [13, { min: 7, max: 8 }]
];

for (const [hours, expected] of placeCountCases) {
  test(`${hours}시간 요청의 장소 수 범위`, () => {
    assert.deepEqual(resolvePlaceCountRange(hours), expected);
  });
}

const roleCases = [
  [["카페"], ["cafe"]],
  [["맛집"], ["food"]],
  [["공원 산책"], ["walk"]],
  [["전시 공연"], ["culture"]],
  [["실내"], ["cafe", "culture"]],
  [["와인바"], ["nightlife"]],
  [["노래방"], ["karaoke"]],
  [["방탈출"], ["activity"]],
  [["글램핑"], ["camping"]],
  [["롯데월드"], ["amusement"]],
  [["야경 명소"], ["attraction"]]
];

for (const [categories, expected] of roleCases) {
  test(`카테고리 role 변환: ${categories.join(", ")}`, () => {
    assert.deepEqual(requestedRolesFromCategories(categories), expected);
  });
}

test("동일 category에서 role을 중복 생성하지 않는다", () => {
  assert.deepEqual(requestedRolesFromCategories(["카페", "커피", "디저트 카페"]), ["cafe"]);
});

test("KST 18시 전에는 카페가 식사보다 앞선다", () => {
  const dateTime = "2026-08-19T08:59:00.000Z";
  assert.equal(resolveRequestHourKst(dateTime), 17);
  assert.deepEqual(defaultRoleOrder(dateTime).slice(0, 2), ["cafe", "food"]);
});

test("KST 18시 이후에는 식사가 카페보다 앞선다", () => {
  const dateTime = "2026-08-19T09:00:00.000Z";
  assert.equal(resolveRequestHourKst(dateTime), 18);
  assert.deepEqual(defaultRoleOrder(dateTime).slice(0, 2), ["food", "cafe"]);
});

const categoryCases = [
  [{ sourceDataset: "SearchParkInfoService", title: "서울숲" }, "park"],
  [
    { sourceDataset: "LOCALDATA_072404", title: "한식당", metadata: { businessType: "한식" } },
    "food"
  ],
  [{ sourceDataset: "culturalSpaceInfo", title: "서울 미술관" }, "culture"],
  [{ sourceDataset: "viewNightSpot", title: "한강 야경" }, "attraction"]
];

for (const [input, family] of categoryCases) {
  test(`공공데이터 category 분류: ${input.title}`, () => {
    assert.equal(classifyPublicDataCategory(input).placeFamily, family);
  });
}

test("Kakao 베이커리 카페를 cafe로 정규화한다", () => {
  assert.deepEqual(
    classifyKakaoPlaceCategory({
      categoryName: "음식점 > 카페 > 베이커리카페",
      categoryGroupName: "카페",
      placeName: "테스트 베이커리"
    }),
    {
      placeFamily: "cafe",
      placeType: "bakery_cafe",
      placeSubtype: null,
      categoryConfidence: 0.88
    }
  );
});

test("Kakao 음식점 category는 추천 대상으로 허용한다", () => {
  assert.equal(
    isEligibleKakaoPlaceCategory({ categoryName: "음식점 > 한식", categoryGroupName: "음식점" }),
    true
  );
});

test("Kakao 병원 category는 추천 대상에서 제외한다", () => {
  assert.equal(
    isEligibleKakaoPlaceCategory({ categoryName: "의료 > 병원", categoryGroupName: "병원" }),
    false
  );
});

test("동일 좌표의 fallback 이동 거리는 0이다", () => {
  const coordinate = { latitude: 37.5665, longitude: 126.978 };
  assert.equal(mapClient.calculateDistanceMeter(coordinate, coordinate), 0);
});

test("도보 시간 추정은 최소 1분을 보장한다", () => {
  assert.equal(mapClient.estimateWalkingDurationMinute(0), 1);
});

test("다중 지점 fallback route는 leg 합계와 일치한다", () => {
  const route = mapClient.estimateWalkingRoute([
    { latitude: 37.5445, longitude: 127.0557 },
    { latitude: 37.548, longitude: 127.043 },
    { latitude: 37.5479, longitude: 127.041 }
  ]);
  assert.equal(route.provider, "estimated");
  assert.equal(route.isFallback, true);
  assert.equal(route.legs.length, 2);
  assert.equal(
    route.totalDistanceMeter,
    route.legs.reduce((sum, leg) => sum + leg.distanceMeter, 0)
  );
});

test("scoring 가중치 총합은 100점이다", () => {
  assert.equal(MAX_RECOMMENDATION_SCORE, 100);
  assert.equal(
    Object.values(SCORE_WEIGHT).reduce((sum, value) => sum + value, 0),
    100
  );
});

test("회원가입 입력은 email과 nickname을 정규화한다", () => {
  const result = validateSignupRequest({
    email: " TEST@Example.com ",
    password: "password123",
    nickname: " 서울메이트 "
  });
  assert.equal(result.email, "test@example.com");
  assert.equal(result.nickname, "서울메이트");
});

test("8자 미만 비밀번호는 거부한다", () => {
  assert.throws(
    () =>
      validateSignupRequest({ email: "test@example.com", password: "short", nickname: "테스트" }),
    /password는 8자 이상/
  );
});

test("지역 alias를 사용해 망원과 마포구를 같은 권역으로 검증한다", async () => {
  const result = await validateRecommendationNode({
    parsedRequest: { region: "망원", durationHours: 2 },
    candidatePlaces: [{ id: 1, title: "망원 테스트 장소", category: "공원", region: "마포구" }],
    course: {
      title: "테스트",
      totalScore: 80,
      estimatedBudget: 0,
      places: [
        {
          order: 1,
          placeId: 1,
          title: "망원 테스트 장소",
          category: "공원",
          estimatedTimeMinute: 60
        }
      ]
    },
    warnings: [],
    errors: []
  });
  assert.equal(result.validation?.isValid, true);
});

test("체류시간과 이동시간의 합이 요청 시간을 초과하면 거부한다", async () => {
  const result = await validateRecommendationNode({
    parsedRequest: { durationHours: 2 },
    candidatePlaces: [{ id: 1, title: "테스트 장소", category: "문화" }],
    course: {
      title: "테스트",
      totalScore: 80,
      estimatedBudget: 0,
      places: [
        {
          order: 1,
          placeId: 1,
          title: "테스트 장소",
          category: "문화",
          estimatedTimeMinute: 110,
          moveTimeMinute: 20
        }
      ]
    },
    warnings: [],
    errors: []
  });
  assert.equal(result.validation?.isValid, false);
  assert.match(result.validation?.errors[0] ?? "", /요청 시간을 초과/);
});

test("완전한 구조화 입력은 외부 LLM 없이 즉시 병합한다", async () => {
  const startedAt = performance.now();
  const result = await parseUserRequestNode({
    rawInput: "성수에서 30000원 이하 첫 데이트",
    parsedRequest: {
      region: "성수",
      budget: 30000,
      durationHours: 4,
      mood: ["조용한"],
      purpose: "첫 데이트"
    },
    warnings: [],
    errors: []
  });

  assert.equal(result.parsedRequest?.region, "성수");
  assert.equal(result.parsedRequest?.budget, 30000);
  assert.ok(performance.now() - startedAt < 100);
});
