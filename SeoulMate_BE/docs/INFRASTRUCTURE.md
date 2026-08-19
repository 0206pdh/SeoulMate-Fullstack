# SeoulMate 인프라 아키텍처

이 문서는 SeoulMate의 최종 배포 구성을 포트폴리오와 운영 인수인계 관점에서 설명한다. 현재 운영 기준은 Kubernetes/EKS가 아니라 **AWS EC2 + Nginx + PM2 + RDS PostgreSQL**이다.

![SeoulMate AWS 아키텍처](../../docs/assets/seoulmate-final-architecture.drawio.png)

## 1. 아키텍처 요약

SeoulMate는 초기 서비스 규모와 팀의 운영 역량에 맞춰 한 대의 EC2에서 API와 데이터 적재 작업을 운영하고, 영속 데이터는 별도의 RDS PostgreSQL에 저장한다. 외부 요청은 Nginx만 받으며 Express 애플리케이션의 3000 포트는 인터넷에 직접 공개하지 않는다.

```text
Web / Mobile Client
  -> HTTPS 443
  -> Internet Gateway
  -> EC2 Security Group
  -> Nginx (TLS 종료, reverse proxy)
  -> PM2
  -> Node.js 20 + TypeScript + Express (127.0.0.1:3000)
       -> LangGraph 추천 파이프라인
       -> 운영 데이터 수집·정규화 작업
       -> 외부 API: OpenAI, Kakao, 기상청, 서울 열린데이터광장
       -> RDS Security Group
       -> RDS PostgreSQL 16 (5432, private subnet)

GitHub main push
  -> GitHub Actions
  -> SSH to EC2
  -> 소스 동기화 / 의존성 설치 / TypeScript 빌드
  -> pm2 reload
```

## 2. AWS 네트워크 구성

### 리전과 가용 영역

- 리전: `ap-northeast-2`(서울)
- 애플리케이션 EC2: `ap-northeast-2a`의 public subnet
- RDS DB subnet group: `ap-northeast-2a`, `ap-northeast-2c`의 private subnet
- 서비스 인스턴스: EC2 1대, RDS PostgreSQL 1대

DB subnet group이 두 AZ에 걸쳐 있다는 사실과 Multi-AZ 배포는 서로 다르다. RDS는 DB subnet group 생성을 위해 서로 다른 AZ의 subnet을 요구하지만, standby DB가 자동으로 만들어지는 것은 아니다. 따라서 현재 구성은 네트워크 범위는 두 AZ에 걸치지만 **애플리케이션과 데이터베이스의 실행 가용성은 Single-AZ**로 분류한다.

단일 AZ를 선택한 이유는 초기 트래픽에서 ALB, Auto Scaling Group, 다중 EC2, RDS Multi-AZ가 주는 비용과 운영 복잡도가 가용성 이득보다 컸기 때문이다. 대신 애플리케이션과 DB를 분리하고, 향후 확장 시 교체하기 쉬운 경계를 먼저 만들었다.

### VPC와 subnet

| 구역                           | 배치 리소스              | 외부 접근             | 목적                          |
| ------------------------------ | ------------------------ | --------------------- | ----------------------------- |
| Public subnet (`2a`)           | EC2, Nginx, PM2, Express | 80/443 허용, SSH 제한 | API 요청 수신과 외부 API 호출 |
| Private DB subnet (`2a`, `2c`) | RDS PostgreSQL           | 인터넷 직접 접근 차단 | 애플리케이션 데이터 영속화    |

EC2에는 Elastic IP를 연결해 DNS A 레코드의 목적지가 인스턴스 재시작 후에도 바뀌지 않게 했다. public subnet의 route table은 `0.0.0.0/0`을 Internet Gateway로 전달한다. RDS는 public access를 비활성화하고 EC2의 보안 그룹을 출발지로 하는 PostgreSQL 연결만 허용한다.

### 보안 그룹과 포트

| 구간              | 포트 | 접근 주체        | 설명                         |
| ----------------- | ---: | ---------------- | ---------------------------- |
| Internet -> Nginx |   80 | 전체             | HTTPS 전환과 인증서 발급용   |
| Internet -> Nginx |  443 | 전체             | 실제 API HTTPS 트래픽        |
| 관리자 -> EC2     |   22 | 관리자 고정 IP   | 배포·장애 대응 SSH           |
| Nginx -> Express  | 3000 | EC2 loopback     | 외부 SG에 공개하지 않음      |
| EC2 -> RDS        | 5432 | EC2 SG -> RDS SG | PostgreSQL 전용              |
| EC2 -> 외부 API   |  443 | EC2 outbound     | OpenAI, Kakao, 공공 API 호출 |

보안의 핵심은 포트를 단순히 닫는 것이 아니라 **신뢰 주체를 SG로 연결하는 것**이다. RDS 5432의 source를 임의 IP 대역이 아닌 EC2 SG로 지정하므로 인스턴스 주소가 바뀌어도 접근 정책이 유지된다. 환경 변수와 API 키는 Git에 저장하지 않고 EC2의 `.env`와 GitHub Actions Secrets에서 관리한다.

## 3. 요청 처리 경로

1. 클라이언트가 `api.seoulmate.my`에 HTTPS 요청을 보낸다.
2. DNS의 A 레코드가 EC2 Elastic IP를 반환한다.
3. Internet Gateway와 EC2 보안 그룹을 거쳐 Nginx의 443 포트에 도달한다.
4. Nginx가 TLS를 종료하고 원본 host, client IP, scheme 정보를 헤더에 보존한 채 `127.0.0.1:3000`으로 전달한다.
5. PM2가 관리하는 Express 프로세스가 인증, validation, 도메인 로직을 수행한다.
6. 일반 API는 repository를 통해 RDS를 조회하고, 추천 API는 LangGraph 파이프라인을 실행한다.
7. 응답이 Nginx를 거쳐 HTTPS로 반환된다.

이 구조에서 Nginx는 public edge, Express는 application runtime, RDS는 persistence라는 명확한 책임을 가진다.

## 4. Nginx를 사용한 이유와 구성

Node.js도 HTTP를 직접 받을 수 있지만 운영 서버의 공인 진입점으로 두지 않았다. Nginx를 앞에 둔 이유는 다음과 같다.

- TLS 인증서와 HTTPS redirect를 애플리케이션 코드 밖에서 일관되게 처리한다.
- Express의 3000 포트를 loopback에 숨겨 공격 표면을 줄인다.
- client IP, host, protocol 헤더를 표준화한다.
- 정적 응답, 압축, request size, timeout, access/error log를 웹 계층에서 제어한다.
- 이후 upstream을 여러 프로세스나 ALB/EKS로 바꾸더라도 클라이언트 계약을 유지할 수 있다.

운영 설정의 핵심 형태는 다음과 같다.

```nginx
server {
    listen 80;
    server_name api.seoulmate.my;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.seoulmate.my;

    ssl_certificate /etc/letsencrypt/live/api.seoulmate.my/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.seoulmate.my/privkey.pem;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 120s;
    }
}
```

`proxy_read_timeout`은 외부 API와 LLM을 포함하는 추천 요청이 일반 CRUD보다 오래 걸릴 수 있어 여유를 둔다. 무제한으로 늘리지는 않아 upstream 장애가 연결 고갈로 번지는 것을 막는다. 인증서는 Certbot으로 발급·갱신하며 `nginx -t`를 통과한 뒤 reload한다.

## 5. PM2를 사용한 이유와 동작

PM2는 Node.js 프로세스를 단순한 SSH 세션에서 분리해 운영 프로세스로 관리한다.

- 애플리케이션 예외나 프로세스 종료 시 자동 재시작
- 이름 기반 상태 확인과 로그 조회
- 서버 재부팅 후 startup script를 통한 복구
- `reload`를 이용한 짧은 배포 중단
- 실행 환경과 메모리 상태 관찰

기본 프로세스 이름은 `seoulmate-be`이고 진입점은 컴파일된 `dist/server.js`다.

```bash
pm2 start dist/server.js --name seoulmate-be
pm2 save
pm2 startup

pm2 status
pm2 logs seoulmate-be
pm2 monit
```

GitHub Actions는 기존 프로세스가 있으면 `pm2 reload seoulmate-be`, 최초 배포이면 `pm2 start dist/server.js --name seoulmate-be`를 실행한다. PM2는 프로세스 가용성을 높이지만 EC2 자체의 AZ 장애까지 해결하지는 않는다. 즉 PM2의 재시작과 Multi-AZ 고가용성은 서로 다른 계층의 문제다.

## 6. 애플리케이션과 데이터베이스

### Express 애플리케이션

애플리케이션은 TypeScript를 `dist/`로 컴파일해 Node.js에서 실행한다. HTTP 계층은 `routes -> controllers -> services -> repositories`로 분리했다.

- route: endpoint와 middleware 조합
- controller: HTTP 입력과 응답 변환
- service: 인증·추천·공공데이터 비즈니스 로직
- repository: PostgreSQL 쿼리와 영속화 경계
- client: OpenAI, Kakao, 서울시, 기상청 API 어댑터
- graph: 추천 상태와 단계별 orchestration
- job: 요청 처리와 분리된 데이터 수집·정규화 작업

### RDS PostgreSQL

RDS를 EC2 로컬 DB 대신 선택한 이유는 애플리케이션 배포와 데이터 생명주기를 분리하기 위해서다. EC2를 교체해도 데이터가 유지되고, 백업·패치·모니터링 같은 DB 운영 기능을 관리형 서비스에 맡길 수 있다. PostgreSQL은 장소, 사용자, 추천 결과, 점수 상세, 당시의 날씨·가격 snapshot처럼 관계와 일관성이 중요한 데이터를 다루기에 적합하다.

애플리케이션은 connection pool을 사용하고 SSL 연결을 활성화한다. 외부에는 DB endpoint를 공개하지 않으며 5432는 EC2 SG에서만 접근할 수 있다.

## 7. 운영 데이터 파이프라인

추천 요청 시마다 서울시 전체 데이터를 외부 API에서 가져오지 않는다. 데이터 적재를 온라인 요청 경로와 분리해 DB에 미리 정규화한다.

```text
서울 열린데이터광장 / 기상청 / Kakao
  -> 원본 수집
  -> 필드·카테고리 정규화
  -> 주소 기반 좌표 복구
  -> Kakao 장소와 URL 매칭
  -> PostgreSQL UPSERT
  -> 추천 API의 후보 데이터로 사용
```

주요 npm 작업은 `sync:public-data`, `normalize:categories`, `repair:coordinates`, `normalize:kakao-categories`, `match:kakao-urls`, `sync:weather`, `sync:living-population`이다. `ON CONFLICT` 기반 upsert로 재실행 멱등성을 확보하고, 외부 API 일부가 실패해도 이미 적재된 데이터로 추천 경로가 계속 동작하도록 했다.

이 선택은 세 가지 효과가 있다.

- 사용자 요청 latency가 공공 API의 응답 속도에 직접 종속되지 않는다.
- 호출량 제한과 외부 장애의 영향 범위를 줄인다.
- 추천 당시 사용한 후보와 결과를 추적하고 재현할 수 있다.

## 8. 외부 API 연동과 장애 격리

| 제공자              | 사용 목적                          | 실패 시 처리                            |
| ------------------- | ---------------------------------- | --------------------------------------- |
| OpenAI              | 자연어 조건 구조화, 추천 설명 생성 | heuristic parser와 template 설명        |
| Kakao Local         | 장소 존재·주소·카테고리 검증       | DB 후보와 기존 정규화 정보 사용         |
| Kakao Mobility      | 장소 간 이동 정보                  | 좌표 기반 거리·시간 추정                |
| 기상청              | 강수·기온·기상 특보                | 저장된 최신 값 또는 unavailable context |
| 서울 열린데이터광장 | 장소·문화·생활인구 데이터          | 마지막 정상 적재 데이터 사용            |
| Kakao/Google OAuth  | 소셜 로그인                        | provider 오류를 인증 오류로 격리        |

외부 provider 호출은 controller가 아니라 client/service 계층에 둔다. provider 응답을 도메인 형태로 정규화한 뒤 graph state에 넣으므로 상위 추천 로직이 특정 API의 raw schema에 결합되지 않는다.

## 9. GitHub Actions CI/CD

`main` 브랜치 push가 운영 배포를 시작한다. workflow의 실제 단계는 다음과 같다.

1. GitHub-hosted Ubuntu runner가 실행된다.
2. `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` secret으로 EC2에 SSH 접속한다.
3. 최초 배포이면 저장소를 clone하고, 이후 배포이면 `origin/main`과 동기화한다.
4. `SeoulMate_BE`에서 의존성을 설치한다.
5. `npm run build`로 TypeScript compilation을 검증하고 `dist/`를 생성한다.
6. `pm2 reload`로 기존 프로세스를 갱신하고, 없으면 새로 시작한다.
7. `pm2 save`로 현재 프로세스 목록을 저장한다.

```text
push(main)
  -> GitHub Actions
  -> SSH
  -> git sync
  -> npm install
  -> npm run build
  -> pm2 reload || pm2 start
  -> pm2 save
```

SSH key와 host는 repository에 기록하지 않는다. 현재 방식은 작은 서비스에 단순하고 비용 효율적이지만 immutable artifact, 자동 rollback, health-based traffic switching은 제공하지 않는다. 다음 단계에서는 `npm ci`, lint/test gate, release directory 또는 container image, health check 실패 시 rollback을 추가할 수 있다.

## 10. 관측과 장애 대응

### 점검 지점

```bash
curl -I https://api.seoulmate.my/health
sudo nginx -t
sudo systemctl status nginx
pm2 status
pm2 logs seoulmate-be --lines 200
```

장애 구간은 아래 순서로 좁힌다.

1. DNS가 EIP를 가리키는지 확인한다.
2. 443 보안 그룹과 인증서 만료 여부를 확인한다.
3. Nginx error log와 upstream 연결 상태를 확인한다.
4. `127.0.0.1:3000/health`로 Express 자체를 확인한다.
5. PM2 status와 애플리케이션 로그를 확인한다.
6. EC2에서 RDS 5432 연결과 pool 오류를 확인한다.
7. 추천 API만 실패한다면 provider별 timeout/fallback 로그를 확인한다.

애플리케이션은 Pino/Pino HTTP를 사용해 구조화 로그를 남기며 request 단위 추적이 가능하도록 한다. 로그에는 access token, refresh token, 비밀번호, DB password, provider key를 기록하지 않는다.

## 11. 선택의 근거와 trade-off

| 선택                 | 이유                             | 감수한 한계                               |
| -------------------- | -------------------------------- | ----------------------------------------- |
| EC2 1대              | 저비용, 빠른 구축, 직접 디버깅   | instance/AZ 장애가 전체 API 장애로 이어짐 |
| Nginx                | TLS·reverse proxy·edge 정책 집중 | 설정과 인증서 갱신 운영 필요              |
| PM2                  | Node 프로세스 복구와 배포 단순화 | host 장애와 수평 확장은 해결하지 못함     |
| RDS                  | DB 생명주기 분리, 관리형 백업    | EC2 로컬 DB보다 비용 증가                 |
| 사전 적재 batch      | 낮은 latency, 외부 장애 격리     | 데이터 최신성과 job 운영 필요             |
| GitHub Actions + SSH | 간단한 자동 배포                 | rollback/immutable deployment 부족        |
| Single-AZ            | 초기 비용과 복잡도 절감          | AZ 장애에 대한 자동 failover 없음         |

이 구조는 “최대 확장성”보다 **초기 제품을 운영 가능한 수준으로 단순하게 유지하면서 경계를 올바르게 나누는 것**을 목표로 한다. 트래픽과 SLA가 커지면 Nginx 앞에 ALB를 두고, EC2를 private subnet의 Auto Scaling Group으로 늘리며, RDS Multi-AZ와 관리형 secret/monitoring을 적용하는 순서가 자연스럽다.

## 12. 확장 로드맵

1. 배포 전에 lint/test/build를 모두 통과시키고 health check 기반 rollback을 추가한다.
2. CloudWatch metric/alarm과 중앙 로그 보관을 연결한다.
3. RDS automated backup, deletion protection, Multi-AZ를 활성화한다.
4. ALB + Auto Scaling Group + 최소 2개 AZ의 EC2로 전환한다.
5. batch worker를 API 프로세스와 별도 실행 단위로 분리한다.
6. Secrets Manager 또는 Parameter Store로 운영 secret을 이전한다.
7. 배포 빈도와 팀 규모가 충분히 커질 때 container/ECS 또는 EKS로 전환한다.

EKS는 목표가 아니라 운영 요구를 해결하는 수단이다. 현재 구조에서도 application, persistence, provider, batch의 경계가 분리돼 있어 컨테이너 전환 시 도메인 로직을 다시 작성하지 않고 실행 환경만 교체할 수 있다.

## 13. 최종 구성 체크리스트

- [x] 서울 리전 VPC와 public/private subnet 분리
- [x] EC2 Elastic IP와 DNS 연결
- [x] Nginx HTTPS reverse proxy
- [x] Express 3000 포트의 외부 비공개
- [x] PM2 프로세스 관리와 재부팅 복구
- [x] private RDS PostgreSQL과 SG 기반 5432 연결
- [x] GitHub Actions main 배포 자동화
- [x] 공공데이터 수집·정규화·upsert job 분리
- [x] 외부 API client 경계와 fallback
- [x] health endpoint와 계층별 장애 점검 절차

관련 세부 설정은 [VPC_SETUP.md](VPC_SETUP.md), [AWS_SECURITY_GROUPS.md](AWS_SECURITY_GROUPS.md), [DEPLOYMENT.md](DEPLOYMENT.md), [DOMAIN_AND_SERVER_BINDING.md](DOMAIN_AND_SERVER_BINDING.md)를 참고한다.
