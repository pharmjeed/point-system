# تثبيت الإصدار الثاني على الخادم وتحديثه — دليل المالك

> المرجع التفصيلي: `docs/DEPLOYMENT.md` §14 و§14.1. القرارات: DEC-457، DEC-630 … DEC-635.
> كل الأوامر تُشغَّل **على الخادم** (Oracle، `app.pointsa.net`) بالمستخدم الذي يملك Docker، لا بـ`root` إن أمكن.

## 1. ما الذي سيعمل على الخادم

بيئة **staging** كاملة للإصدار الثاني، منفصلة عن المشاريع الأخرى (مشروع compose اسمه `point`):

| الخدمة | ماذا تفعل |
|---|---|
| `postgres` · `minio` | قاعدة البيانات والصور على الخادم نفسه |
| `api` · `worker` · `web` | الخادم والعامل وتطبيق الموظفين ولوحة المنصة `/platform` وواجهة تطبيق العميل `/v1/customer/*` |
| `wa-simulator` | محاكي واتساب (لا يراسل أحدًا)، صفحته `https://sim.pointsa.net` بكلمة مرور |
| `payment-simulator` | محاكي بوابة الدفع Moyasar، **داخلي فقط** بلا منفذ منشور (لا تُخصم أي بطاقة) |

الفوترة الإلكترونية وإشعارات الجوال محاكاة داخلية أيضًا: لا يصل شيء إلى الهيئة ولا إلى أي جهاز.

## 2. التثبيت بأمر واحد (أول مرة)

```bash
sudo mkdir -p /opt/point && sudo chown "$USER" /opt/point && git clone -b claude/v2-platform-operators https://github.com/pharmjeed/point-system.git /opt/point && cd /opt/point && bash infra/deploy/install.sh
```

- المستودع خاص: يطلب `git` اسم مستخدم GitHub ورمز وصول (أو استخدم مفتاح SSH للنشر).
- يسأل السكربت: اسم المضيف (`app.pointsa.net`)، البريد، صفحة المحاكي (`sim.pointsa.net`)، جوال المالك واسمه، اسم المؤسسة، ثم جوال **مالك المنصة** واسمه (اضغط Enter ليكون المالك نفسه).
- يطبع **كلمتي مرور مؤقتتين مرة واحدة** (المالك، ومالك المنصة) وكلمة مرور صفحة المحاكي. انسخها فورًا؛ لا تُحفظ في مكان آخر.
- أول دخول: `https://app.pointsa.net/staff/login` للمالك، و`https://app.pointsa.net/platform/login` لمالك المنصة؛ كل منهما يغيّر كلمة المرور ثم يضبط تطبيق المصادقة.
- ثم من «قناة واتساب» في الإدارة: أنشئ القناة بوضع «محاكي» بالمعرّفات التي يطبعها السكربت، وزامن القوالب. قبل ذلك لا يستطيع تطبيق العميل طلب رمز الدخول (`WA_CHANNEL_UNAVAILABLE`).

## 3. التحديث (وترقية تثبيت الإصدار الأول)

```bash
cd /opt/point && bash infra/backup/backup.sh   # نسخة احتياطية أولًا (DEPLOYMENT.md §12)
cd /opt/point && git fetch origin && git checkout claude/v2-platform-operators && git pull --ff-only && bash infra/deploy/install.sh
```

- السكربت **يحفظ `.env` وأسراره كما هي**، ويُلحق فقط المفاتيح الجديدة الناقصة (يطبع أسماءها لا قيمها)، ويشغّل محاكي الدفع، وينشئ مالك المنصة إن لم يوجد.
- لا يسأل مجددًا عن المالك إن كان قد أُنشئ. التشغيل بلا أسئلة: `POINT_YES=1 bash infra/deploy/install.sh`.

## 4. الحالة والسجلات

```bash
cd /opt/point
bash infra/deploy/pc.sh ps                              # كل الخدمات Up و(healthy)
curl -fsS https://app.pointsa.net/health/ready          # {"status":"ok",…}
bash infra/deploy/pc.sh logs -f --tail 100 api worker   # السجلات الحية (Ctrl+C للخروج)
bash infra/deploy/pc.sh logs --tail 50 payment-simulator wa-simulator
bash infra/deploy/smoke-payments.sh                     # ذهاب وإياب محاكي الدفع: «round trip: ok»
bash infra/deploy/pc.sh restart api worker              # إعادة تشغيل الخادم والعامل
```

## 5. تحرير مساحة القرص بأمان

السكربت يفعل ذلك تلقائيًا عند كل تحديث: يطبع المساحة قبل البناء وبعده، ويرفض البدء إن قلّت المساحة الحرة عن 8 GB، ويحذف بعد البناء **صور بوينت القديمة المعلّقة فقط** وذاكرة البناء غير المستعملة منذ 24 ساعة. يدويًا:

```bash
df -h /var/lib/docker                    # المساحة الحرة
docker system df                         # من يستهلك: الصور، الحاويات، الأحجام، ذاكرة البناء
docker image prune -f --filter label=com.docker.compose.project=point   # صور بوينت المعلّقة فقط
docker builder prune -f --filter until=24h   # ذاكرة البناء الأقدم من يوم (لكل البناءات: يبطئ البناء التالي فقط)
```

**لا تشغّل أبدًا** `docker system prune` ولا `docker volume prune` ولا `docker image prune -a`: تحذف بيانات المشاريع الأخرى وقد تحذف **قاعدة بيانات بوينت** (`point_pg_data`) وصورها (`point_minio_data`). وإن بقيت المساحة ضيقة فانظر `sudo du -xsh /var/log /home /opt` قبل حذف أي شيء.

## 6. إن فشل شيء

- «ports … are taken» أو «port 8095 is in use»: منفذ يستعمله برنامج آخر؛ اختر غيره: `POINT_HTTP_PORT=8195 bash infra/deploy/install.sh`.
- «a build needs at least 8 GB»: حرّر المساحة (§5) ثم أعد التشغيل؛ لم يتوقف شيء مما يعمل.
- «the api did not become ready»: السكربت يطبع آخر السجلات؛ أرسلها لفريق التطوير (لا تحتوي أسرارًا).
- البوابة رفضت ملف الموقع: السكربت يعيد الحالة السابقة ولا يمس المواقع الأخرى.
