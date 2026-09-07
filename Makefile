BUILD_DIR = build
CLEANCSS = ./node_modules/.bin/cleancss
DEPLOY_DIR = libs
LIBJITSIMEET_DIR = node_modules/lib-jitsi-meet
OLM_DIR = node_modules/@matrix-org/olm
TF_WASM_DIR = node_modules/@tensorflow/tfjs-backend-wasm/dist/
RNNOISE_WASM_DIR = node_modules/@jitsi/rnnoise-wasm/dist
EXCALIDRAW_DIR = node_modules/@jitsi/excalidraw/dist/prod
EXCALIDRAW_DIR_DEV = node_modules/@jitsi/excalidraw/dist/dev
TFLITE_WASM = react/features/stream-effects/virtual-background/vendor/tflite
MEET_MODELS_DIR  = react/features/stream-effects/virtual-background/vendor/models
MEDIAPIPE_SEGMENTATION_DIR = node_modules/@mediapipe/selfie_segmentation
FACE_MODELS_DIR = node_modules/@vladmandic/human-models/models
NODE_SASS = ./node_modules/.bin/sass
NPM = npm
# The heap ceiling for a preview build, derived from the machine this runs on
# rather than assumed. Recursively expanded on purpose: only the preview
# targets reference it, so a full build never pays for it. The fallback keeps
# a broken sizer from producing an empty --max-old-space-size=.
PREVIEW_HEAP_MB = $(shell node scripts/heap-size.js || echo 2048)
OUTPUT_DIR = .
STYLES_BUNDLE = css/all.bundle.css
STYLES_DESTINATION = css/all.css
STYLES_MAIN = css/main.scss
ifeq ($(OS),Windows_NT)
	WEBPACK = .\node_modules\.bin\webpack --progress
	WEBPACK_DEV_SERVER = .\node_modules\.bin\webpack serve --mode development --progress
else
	WEBPACK = ./node_modules/.bin/webpack --progress
	WEBPACK_DEV_SERVER = ./node_modules/.bin/webpack serve --mode development --progress
endif

all: compile deploy

compile: clean
	NODE_OPTIONS=--max-old-space-size=8192 \
	$(WEBPACK)

# A build for a preview host: the webpack preview profile (fewer bundles, no
# source maps -- see PREVIEW_ENTRIES in webpack.config.js) and a heap the
# machine can actually back. `make all` is unchanged; this is a second way in,
# not a variant of the first.
preview: compile-preview deploy-preview

compile-preview: clean
	MEETSPACE_PREVIEW=1 \
	NODE_OPTIONS=--max-old-space-size=$(PREVIEW_HEAP_MB) \
	$(WEBPACK)

clean:
	rm -fr $(BUILD_DIR)

.NOTPARALLEL:
deploy: deploy-init deploy-appbundle deploy-rnnoise-binary deploy-excalidraw deploy-tflite deploy-meet-models deploy-mediapipe-segmentation deploy-lib-jitsi-meet deploy-olm deploy-tf-wasm deploy-css deploy-local deploy-face-landmarks

deploy-init:
	rm -fr $(DEPLOY_DIR)
	mkdir -p $(DEPLOY_DIR)

deploy-appbundle:
	cp \
		$(BUILD_DIR)/app.bundle.min.js \
		$(BUILD_DIR)/app.bundle.min.js.map \
		$(BUILD_DIR)/external_api.min.js \
		$(BUILD_DIR)/external_api.min.js.map \
		$(BUILD_DIR)/alwaysontop.min.js \
		$(BUILD_DIR)/alwaysontop.min.js.map \
		$(BUILD_DIR)/documentpip.min.js \
		$(BUILD_DIR)/documentpip.min.js.map \
		$(BUILD_DIR)/face-landmarks-worker.min.js \
		$(BUILD_DIR)/face-landmarks-worker.min.js.map \
		$(BUILD_DIR)/noise-suppressor-worklet.min.js \
		$(BUILD_DIR)/noise-suppressor-worklet.min.js.map \
		$(BUILD_DIR)/screenshot-capture-worker.min.js \
		$(BUILD_DIR)/screenshot-capture-worker.min.js.map \
		$(BUILD_DIR)/vb-inference-worker.min.js \
		$(BUILD_DIR)/vb-inference-worker.min.js.map \
		$(DEPLOY_DIR)
	cp \
		$(BUILD_DIR)/close3.min.js \
		$(BUILD_DIR)/close3.min.js.map \
		$(DEPLOY_DIR) || true
	cp -r $(BUILD_DIR)/chunks $(DEPLOY_DIR)/chunks

# The deploy of a preview build. Identical to `deploy` but for the app bundle
# copy: every other target copies assets out of node_modules, which the preview
# profile does not change.
.NOTPARALLEL:
deploy-preview: deploy-init deploy-appbundle-preview deploy-rnnoise-binary deploy-excalidraw deploy-tflite deploy-meet-models deploy-mediapipe-segmentation deploy-lib-jitsi-meet deploy-olm deploy-tf-wasm deploy-css deploy-local deploy-face-landmarks

# Only the bundles the preview profile emits, and no source maps -- it does not
# build them. Copying anything else would fail the deploy over a file the build
# was never asked to produce, which the preview log can only report as the
# build stage failing. This list is PREVIEW_ENTRIES in webpack.config.js;
# scripts/preview.test.js holds the two together.
deploy-appbundle-preview:
	cp \
		$(BUILD_DIR)/app.bundle.min.js \
		$(BUILD_DIR)/external_api.min.js \
		$(BUILD_DIR)/face-landmarks-worker.min.js \
		$(BUILD_DIR)/noise-suppressor-worklet.min.js \
		$(BUILD_DIR)/screenshot-capture-worker.min.js \
		$(BUILD_DIR)/vb-inference-worker.min.js \
		$(DEPLOY_DIR)
	cp -r $(BUILD_DIR)/chunks $(DEPLOY_DIR)/chunks

deploy-lib-jitsi-meet:
	cp \
		$(LIBJITSIMEET_DIR)/dist/umd/lib-jitsi-meet.* \
		$(DEPLOY_DIR)

deploy-olm:
	cp \
		$(OLM_DIR)/olm.wasm \
		$(DEPLOY_DIR)

deploy-tf-wasm:
	cp \
		$(TF_WASM_DIR)/*.wasm \
		$(DEPLOY_DIR)

deploy-rnnoise-binary:
	cp \
		$(RNNOISE_WASM_DIR)/rnnoise.wasm \
		$(DEPLOY_DIR)

deploy-tflite:
	cp \
		$(TFLITE_WASM)/*.wasm \
		$(DEPLOY_DIR)

deploy-excalidraw:
	mkdir -p $(DEPLOY_DIR)/excalidraw
	cp -R $(EXCALIDRAW_DIR)/fonts $(DEPLOY_DIR)/excalidraw/

deploy-excalidraw-dev:
	mkdir -p $(DEPLOY_DIR)/excalidraw
	cp -R $(EXCALIDRAW_DIR_DEV)/fonts $(DEPLOY_DIR)/excalidraw/

deploy-meet-models:
	cp \
		$(MEET_MODELS_DIR)/*.tflite \
		$(DEPLOY_DIR)
	mkdir -p $(DEPLOY_DIR)/selfie_segmentation_landscape_tfjs
	cp \
		$(MEET_MODELS_DIR)/selfie_segmentation_landscape_tfjs/model.json \
		$(MEET_MODELS_DIR)/selfie_segmentation_landscape_tfjs/group1-shard1of1.bin \
		$(DEPLOY_DIR)/selfie_segmentation_landscape_tfjs

deploy-mediapipe-segmentation:
	mkdir -p $(DEPLOY_DIR)/mediapipe-segmentation
	cp \
		$(MEDIAPIPE_SEGMENTATION_DIR)/selfie_segmentation* \
		$(DEPLOY_DIR)/mediapipe-segmentation

deploy-face-landmarks:
	cp \
		$(FACE_MODELS_DIR)/blazeface-front.bin \
		$(FACE_MODELS_DIR)/blazeface-front.json \
		$(FACE_MODELS_DIR)/emotion.bin \
		$(FACE_MODELS_DIR)/emotion.json \
		$(DEPLOY_DIR)

deploy-css:
	$(NODE_SASS) $(STYLES_MAIN) $(STYLES_BUNDLE) && \
	$(CLEANCSS) --skip-rebase $(STYLES_BUNDLE) > $(STYLES_DESTINATION) && \
	rm $(STYLES_BUNDLE)

deploy-local:
	([ ! -x deploy-local.sh ] || ./deploy-local.sh)

.NOTPARALLEL:
dev: deploy-init deploy-css deploy-rnnoise-binary deploy-tflite deploy-meet-models deploy-mediapipe-segmentation deploy-lib-jitsi-meet deploy-olm deploy-tf-wasm deploy-excalidraw-dev deploy-face-landmarks
	$(WEBPACK_DEV_SERVER)

# MeetSpace demo mode: same dev server, but the app shell and both config files
# are served from this checkout so the product is browsable with or without a
# reachable backend. See DEMO.md.
.NOTPARALLEL:
demo: demo-assets
	MEETSPACE_DEMO=1 $(WEBPACK_DEV_SERVER)

# Everything the demo needs on disk before webpack starts. Split out so the
# preview launcher (demo/start.js) can run it after it has already bound the
# port a harness is probing.
.NOTPARALLEL:
demo-assets: deploy-init deploy-css deploy-rnnoise-binary deploy-tflite deploy-meet-models deploy-mediapipe-segmentation deploy-lib-jitsi-meet deploy-olm deploy-tf-wasm deploy-excalidraw-dev deploy-face-landmarks demo-shell

demo-shell:
	node demo/build-index.js

source-package: compile deploy
	mkdir -p source_package/jitsi-meet/css && \
	cp -r *.js *.html resources/*.txt fonts images libs static sounds LICENSE lang source_package/jitsi-meet && \
	cp css/all.css source_package/jitsi-meet/css && \
	(cd source_package ; tar cjf ../jitsi-meet.tar.bz2 jitsi-meet) && \
	rm -rf source_package
