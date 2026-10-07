// Astonishing Sparkline plugin for Open MCT
//
// A simple, real-sample telemetry sparkline.
//
// Design:
//   - Historical data: openmct.telemetry.request()
//   - Realtime data:   openmct.telemetry.subscribe()
//   - Actual telemetry samples are stored in a timestamp-keyed buffer.
//   - Duplicate timestamps are replaced, not drawn twice.
//   - Samples are always sorted chronologically before rendering.
//   - X axis = current Open MCT TimeContext.
//   - Y axis = telemetry metadata min/max.
//   - No minmax strategy.
//   - No TelemetryCollection.
//   - No dynamic Y-axis rescaling.
//   - No arbitrary removal of the left side of the waveform.

export default function astonishingSparkline(options = {}) {
    const maxSamples = Math.max(
        500,
        Number(options.maxSamples) || 10000
    );

    const bgColor =
        options.bgColor || "#07131a";

    const lineColor =
        options.lineColor || "#00e0a3";

    const lineWidth =
        Number(options.lineWidth) > 0
            ? Number(options.lineWidth)
            : 2;

    return function install(openmct) {
        /*
         * ------------------------------------------------------------
         * CSS
         * ------------------------------------------------------------
         */

        if (
            !document.getElementById(
                "astonishing-sparkline-styles"
            )
        ) {
            const style =
                document.createElement("style");

            style.id =
                "astonishing-sparkline-styles";

            style.textContent = `
                .astonishing-sparkline-container {
                    position: relative;

                    width: 100%;
                    height: 220px;

                    box-sizing: border-box;

                    padding: 8px;
                    margin: 0;

                    overflow: hidden;

                    background: rgba(0, 0, 0, 0.20);

                    border-radius: 4px;
                }

                .astonishing-sparkline-header {
                    width: 100%;
                    height: 16px;

                    margin: 0 0 6px 0;
                    padding: 0;

                    box-sizing: border-box;

                    font-family: sans-serif;
                    font-size: 12px;
                    line-height: 16px;

                    color: #cccccc;

                    text-transform: uppercase;
                    letter-spacing: 0.5px;

                    overflow: hidden;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                }

                .astonishing-sparkline-canvas {
                    display: block;

                    width: 100%;
                    height: calc(100% - 22px);

                    margin: 0;
                    padding: 0;
                }
            `;

            document.head.appendChild(style);
        }

        /*
         * ------------------------------------------------------------
         * Object View Provider
         * ------------------------------------------------------------
         */

        openmct.objectViews.addProvider({
            key: "astonishing.sparkline",

            name: "Astonishing Sparkline",

            canView(domainObject) {
                const metadata =
                    openmct.telemetry.getMetadata(
                        domainObject
                    );

                if (!metadata) {
                    return false;
                }

                if (
                    typeof metadata.valuesForHints !==
                    "function"
                ) {
                    return false;
                }

                return Boolean(
                    metadata.valuesForHints([
                        "range"
                    ])[0]
                );
            },

            view(domainObject, objectPath) {
                /*
                 * --------------------------------------------------------
                 * DOM
                 * --------------------------------------------------------
                 */

                let containerEl = null;
                let canvas = null;
                let ctx = null;

                /*
                 * --------------------------------------------------------
                 * Open MCT time state
                 * --------------------------------------------------------
                 */

                let timeContext = null;

                /*
                 * --------------------------------------------------------
                 * Telemetry state
                 * --------------------------------------------------------
                 */

                let metadata = null;
                let formatMap = null;

                let rangeMetadata = null;
                let timeMetadata = null;

                let unsubscribe = null;

                /*
                 * --------------------------------------------------------
                 * Sample buffer
                 * --------------------------------------------------------
                 *
                 * Map:
                 *
                 *     timestamp -> value
                 *
                 * This eliminates duplicate historical/realtime points.
                 */

                const samplesByTime =
                    new Map();

                /*
                 * --------------------------------------------------------
                 * Request state
                 * --------------------------------------------------------
                 */

                let requestInProgress = false;
                let requestSerial = 0;

                /*
                 * The buffer covers this interval.
                 *
                 * These values refer to telemetry data actually requested,
                 * not merely the currently visible canvas.
                 */

                let loadedStart = null;
                let loadedEnd = null;

                /*
                 * --------------------------------------------------------
                 * Rendering state
                 * --------------------------------------------------------
                 */

                let destroyed = false;
                let renderFrame = null;
                let resizeObserver = null;

                /*
                 * --------------------------------------------------------
                 * Stable Y axis
                 * --------------------------------------------------------
                 */

                let yMin = null;
                let yMax = null;

                /*
                 * --------------------------------------------------------
                 * Metadata
                 * --------------------------------------------------------
                 */

                function updateMetadata() {
                    metadata =
                        openmct.telemetry.getMetadata(
                            domainObject
                        );

                    formatMap = null;
                    rangeMetadata = null;
                    timeMetadata = null;

                    if (!metadata) {
                        return;
                    }

                    if (
                        typeof metadata.valuesForHints !==
                        "function"
                    ) {
                        return;
                    }

                    rangeMetadata =
                        metadata.valuesForHints([
                            "range"
                        ])[0] || null;

                    if (!rangeMetadata) {
                        return;
                    }

                    formatMap =
                        openmct.telemetry.getFormatMap(
                            metadata
                        );

                    if (!timeContext) {
                        return;
                    }

                    const timeSystem =
                        timeContext.getTimeSystem();

                    if (!timeSystem) {
                        return;
                    }

                    if (
                        typeof metadata.value ===
                        "function"
                    ) {
                        timeMetadata =
                            metadata.value(
                                timeSystem.key
                            ) || null;
                    }

                    /*
                     * Use the telemetry definition's physical limits.
                     *
                     * For a sine generator this should normally be:
                     *
                     *     -amplitude ... +amplitude
                     *
                     * Therefore the graph never "breathes" vertically.
                     */

                    const min =
                        Number(
                            rangeMetadata.min
                        );

                    const max =
                        Number(
                            rangeMetadata.max
                        );

                    if (
                        Number.isFinite(min) &&
                        Number.isFinite(max) &&
                        max > min
                    ) {
                        yMin = min;
                        yMax = max;
                    }
                }

                function getRangeFormatter() {
                    if (
                        !rangeMetadata ||
                        !formatMap
                    ) {
                        return null;
                    }

                    return (
                        formatMap[
                            rangeMetadata.key
                        ] || null
                    );
                }

                function getTimeFormatter() {
                    if (
                        !timeMetadata ||
                        !formatMap
                    ) {
                        return null;
                    }

                    return (
                        formatMap[
                            timeMetadata.key
                        ] || null
                    );
                }

                /*
                 * --------------------------------------------------------
                 * Parse a telemetry datum
                 * --------------------------------------------------------
                 */

                function parseDatum(datum) {
                    const timeFormatter =
                        getTimeFormatter();

                    const rangeFormatter =
                        getRangeFormatter();

                    if (
                        !timeFormatter ||
                        !rangeFormatter
                    ) {
                        return null;
                    }

                    let timestamp;
                    let value;

                    try {
                        timestamp =
                            timeFormatter.parse(
                                datum
                            );

                        value =
                            rangeFormatter.parse(
                                datum
                            );
                    } catch (error) {
                        return null;
                    }

                    if (Array.isArray(value)) {
                        value = value[0];
                    }

                    if (
                        !Number.isFinite(
                            timestamp
                        ) ||
                        !Number.isFinite(value)
                    ) {
                        return null;
                    }

                    return {
                        timestamp,
                        value
                    };
                }

                /*
                 * --------------------------------------------------------
                 * Add telemetry to our buffer
                 * --------------------------------------------------------
                 */

                function addDatum(datum) {
                    const sample =
                        parseDatum(datum);

                    if (!sample) {
                        return false;
                    }

                    /*
                     * If the same timestamp is received again, the newest
                     * value wins.
                     *
                     * This is important when historical data overlaps
                     * realtime data.
                     */
                    samplesByTime.set(
                        sample.timestamp,
                        sample.value
                    );

                    return true;
                }

                /*
                 * --------------------------------------------------------
                 * Convert buffer to ordered samples
                 * --------------------------------------------------------
                 */

                function getOrderedSamples() {
                    const samples = [];

                    samplesByTime.forEach(
                        (value, timestamp) => {
                            samples.push({
                                timestamp,
                                value
                            });
                        }
                    );

                    samples.sort(
                        (a, b) =>
                            a.timestamp -
                            b.timestamp
                    );

                    return samples;
                }

                /*
                 * --------------------------------------------------------
                 * Buffer maintenance
                 * --------------------------------------------------------
                 */

                function pruneBuffer(
                    visibleStart,
                    visibleEnd
                ) {
                    if (
                        !Number.isFinite(
                            visibleStart
                        ) ||
                        !Number.isFinite(
                            visibleEnd
                        ) ||
                        visibleEnd <=
                            visibleStart
                    ) {
                        return;
                    }

                    /*
                     * Keep two complete visible-window widths behind the
                     * current window.
                     *
                     * This prevents unnecessary reloads while a realtime
                     * window is slowly moving forward.
                     */
                    const span =
                        visibleEnd -
                        visibleStart;

                    const keepFrom =
                        visibleStart -
                        span * 2;

                    /*
                     * Do not allow the buffer to grow without bound.
                     */
                    const timestamps =
                        Array.from(
                            samplesByTime.keys()
                        );

                    if (
                        timestamps.length <=
                        maxSamples * 2
                    ) {
                        timestamps.forEach(
                            (timestamp) => {
                                if (
                                    timestamp <
                                    keepFrom
                                ) {
                                    samplesByTime.delete(
                                        timestamp
                                    );
                                }
                            }
                        );

                        return;
                    }

                    /*
                     * Hard upper bound.
                     *
                     * Remove the oldest samples first.
                     */
                    timestamps.sort(
                        (a, b) => a - b
                    );

                    const excess =
                        timestamps.length -
                        maxSamples * 2;

                    for (
                        let i = 0;
                        i < excess;
                        i += 1
                    ) {
                        samplesByTime.delete(
                            timestamps[i]
                        );
                    }

                    timestamps.forEach(
                        (timestamp) => {
                            if (
                                timestamp <
                                keepFrom
                            ) {
                                samplesByTime.delete(
                                    timestamp
                                );
                            }
                        }
                    );
                }

                /*
                 * --------------------------------------------------------
                 * Determine whether historical data is already available
                 * --------------------------------------------------------
                 */

                function bufferContains(
                    start,
                    end
                ) {
                    if (
                        loadedStart === null ||
                        loadedEnd === null
                    ) {
                        return false;
                    }

                    return (
                        start >= loadedStart &&
                        end <= loadedEnd
                    );
                }

                /*
                 * --------------------------------------------------------
                 * Historical telemetry
                 * --------------------------------------------------------
                 */

                async function requestHistorical(
                    force = false
                ) {
                    if (
                        destroyed ||
                        !timeContext
                    ) {
                        return;
                    }

                    const bounds =
                        timeContext.getBounds();

                    if (
                        !bounds ||
                        !Number.isFinite(
                            bounds.start
                        ) ||
                        !Number.isFinite(
                            bounds.end
                        ) ||
                        bounds.end <=
                            bounds.start
                    ) {
                        return;
                    }

                    /*
                     * If our buffer already covers the visible interval,
                     * there is nothing to request.
                     */
                    if (
                        !force &&
                        bufferContains(
                            bounds.start,
                            bounds.end
                        )
                    ) {
                        requestRender();
                        return;
                    }

                    /*
                     * Do not launch a pile of identical requests while
                     * Open MCT's realtime clock is ticking.
                     */
                    if (requestInProgress) {
                        requestRender();
                        return;
                    }

                    const timeSystem =
                        timeContext.getTimeSystem();

                    if (!timeSystem) {
                        return;
                    }

                    const timeFormatter =
                        getTimeFormatter();

                    const rangeFormatter =
                        getRangeFormatter();

                    if (
                        !timeFormatter ||
                        !rangeFormatter
                    ) {
                        return;
                    }

                    requestInProgress =
                        true;

                    const serial =
                        ++requestSerial;

                    const start =
                        bounds.start;

                    const end =
                        bounds.end;

                    try {
                        /*
                         * IMPORTANT:
                         *
                         * We deliberately make a normal telemetry request.
                         *
                         * No:
                         *
                         *     strategy: "minmax"
                         *
                         * No:
                         *
                         *     size: ...
                         *
                         * The provider gives us the actual telemetry
                         * samples.
                         */
                        const data =
                            await openmct.telemetry.request(
                                domainObject,
                                {
                                    start,
                                    end,
                                    domain:
                                        timeSystem.key
                                }
                            );

                        /*
                         * A newer request may have been issued while this
                         * one was in flight.
                         */
                        if (
                            destroyed ||
                            serial !==
                                requestSerial
                        ) {
                            return;
                        }

                        if (
                            Array.isArray(data)
                        ) {
                            for (
                                let i = 0;
                                i < data.length;
                                i += 1
                            ) {
                                addDatum(
                                    data[i]
                                );
                            }
                        }

                        /*
                         * Only claim coverage for the request that actually
                         * completed.
                         */
                        loadedStart =
                            loadedStart === null
                                ? start
                                : Math.min(
                                      loadedStart,
                                      start
                                  );

                        loadedEnd =
                            loadedEnd === null
                                ? end
                                : Math.max(
                                      loadedEnd,
                                      end
                                  );

                        pruneBuffer(
                            start,
                            end
                        );

                        requestRender();
                    } catch (error) {
                        /*
                         * Do not destroy the view because a historical
                         * provider temporarily failed.
                         */
                        if (
                            !destroyed &&
                            serial ===
                                requestSerial
                        ) {
                            console.error(
                                "Astonishing Sparkline historical telemetry request failed:",
                                error
                            );
                        }
                    } finally {
                        if (
                            serial ===
                            requestSerial
                        ) {
                            requestInProgress =
                                false;
                        }
                    }
                }

                /*
                 * --------------------------------------------------------
                 * Realtime subscription
                 * --------------------------------------------------------
                 */

                function subscribeRealtime() {
                    if (
                        destroyed ||
                        !timeContext
                    ) {
                        return;
                    }

                    /*
                     * Remove an existing subscription first.
                     */
                    if (
                        typeof unsubscribe ===
                        "function"
                    ) {
                        unsubscribe();
                        unsubscribe = null;
                    }

                    const timeSystem =
                        timeContext.getTimeSystem();

                    if (!timeSystem) {
                        return;
                    }

                    /*
                     * Open MCT's realtime callback supplies one actual
                     * telemetry datum at a time.
                     */
                    unsubscribe =
                        openmct.telemetry.subscribe(
                            domainObject,
                            (datum) => {
                                if (
                                    destroyed
                                ) {
                                    return;
                                }

                                const added =
                                    addDatum(
                                        datum
                                    );

                                if (!added) {
                                    return;
                                }

                                const bounds =
                                    timeContext.getBounds();

                                if (
                                    bounds &&
                                    Number.isFinite(
                                        bounds.start
                                    ) &&
                                    Number.isFinite(
                                        bounds.end
                                    )
                                ) {
                                    /*
                                     * Realtime data extends our known
                                     * coverage.
                                     */
                                    const sample =
                                        parseDatum(
                                            datum
                                        );

                                    if (
                                        sample
                                    ) {
                                        if (
                                            loadedEnd ===
                                                null ||
                                            sample.timestamp >
                                                loadedEnd
                                        ) {
                                            loadedEnd =
                                                sample.timestamp;
                                        }

                                        if (
                                            loadedStart ===
                                                null
                                        ) {
                                            loadedStart =
                                                sample.timestamp;
                                        }
                                    }

                                    pruneBuffer(
                                        bounds.start,
                                        bounds.end
                                    );
                                }

                                requestRender();
                            },
                            {
                                domain:
                                    timeSystem.key
                            }
                        );
                }

                /*
                 * --------------------------------------------------------
                 * Time system change
                 * --------------------------------------------------------
                 */

                function resetForTimeSystem() {
                    /*
                     * Timestamps can mean something different under a new
                     * time system, so do not mix the old and new data.
                     */
                    samplesByTime.clear();

                    loadedStart = null;
                    loadedEnd = null;

                    yMin = null;
                    yMax = null;

                    updateMetadata();

                    subscribeRealtime();

                    requestHistorical(
                        true
                    );

                    requestRender();
                }

                /*
                 * --------------------------------------------------------
                 * Bounds changed
                 * --------------------------------------------------------
                 */

                function boundsChanged() {
                    if (destroyed) {
                        return;
                    }

                    /*
                     * If the new window is already covered by our buffer,
                     * this is just a visual scroll.
                     *
                     * Otherwise fetch the missing historical interval.
                     */
                    requestHistorical(false);

                    requestRender();
                }

                /*
                 * --------------------------------------------------------
                 * Rendering
                 * --------------------------------------------------------
                 */

                function requestRender() {
                    if (
                        destroyed ||
                        renderFrame !== null
                    ) {
                        return;
                    }

                    renderFrame =
                        window.requestAnimationFrame(
                            render
                        );
                }

                /*
                 * --------------------------------------------------------
                 * Canvas resize
                 * --------------------------------------------------------
                 */

                function resizeCanvas() {
                    if (
                        destroyed ||
                        !canvas ||
                        !ctx
                    ) {
                        return;
                    }

                    const rect =
                        canvas.getBoundingClientRect();

                    const width =
                        Math.max(
                            1,
                            rect.width
                        );

                    const height =
                        Math.max(
                            1,
                            rect.height
                        );

                    const dpr =
                        window.devicePixelRatio ||
                        1;

                    canvas.width =
                        Math.max(
                            2,
                            Math.round(
                                width * dpr
                            )
                        );

                    canvas.height =
                        Math.max(
                            2,
                            Math.round(
                                height * dpr
                            )
                        );

                    ctx.setTransform(
                        dpr,
                        0,
                        0,
                        dpr,
                        0,
                        0
                    );

                    requestRender();
                }

                /*
                 * --------------------------------------------------------
                 * Draw background
                 * --------------------------------------------------------
                 */

                function drawBackground(
                    width,
                    height
                ) {
                    ctx.clearRect(
                        0,
                        0,
                        width,
                        height
                    );

                    ctx.fillStyle =
                        bgColor;

                    ctx.fillRect(
                        0,
                        0,
                        width,
                        height
                    );
                }

                /*
                 * --------------------------------------------------------
                 * Render actual samples
                 * --------------------------------------------------------
                 */

                function render() {
                    renderFrame = null;

                    if (
                        destroyed ||
                        !canvas ||
                        !ctx ||
                        !timeContext
                    ) {
                        return;
                    }

                    const dpr =
                        window.devicePixelRatio ||
                        1;

                    const width =
                        canvas.width / dpr;

                    const height =
                        canvas.height / dpr;

                    if (
                        width <= 0 ||
                        height <= 0
                    ) {
                        return;
                    }

                    drawBackground(
                        width,
                        height
                    );

                    const bounds =
                        timeContext.getBounds();

                    if (
                        !bounds ||
                        !Number.isFinite(
                            bounds.start
                        ) ||
                        !Number.isFinite(
                            bounds.end
                        ) ||
                        bounds.end <=
                            bounds.start
                    ) {
                        return;
                    }

                    /*
                     * Metadata should normally have established these.
                     */
                    if (
                        !Number.isFinite(yMin) ||
                        !Number.isFinite(yMax)
                    ) {
                        updateMetadata();
                    }

                    /*
                     * Last-resort fallback only.
                     *
                     * This is NOT recalculated every frame.
                     */
                    if (
                        !Number.isFinite(yMin) ||
                        !Number.isFinite(yMax)
                    ) {
                        const all =
                            getOrderedSamples();

                        if (all.length) {
                            let min =
                                Infinity;

                            let max =
                                -Infinity;

                            for (
                                let i = 0;
                                i < all.length;
                                i += 1
                            ) {
                                min =
                                    Math.min(
                                        min,
                                        all[i].value
                                    );

                                max =
                                    Math.max(
                                        max,
                                        all[i].value
                                    );
                            }

                            if (
                                Number.isFinite(
                                    min
                                ) &&
                                Number.isFinite(
                                    max
                                )
                            ) {
                                if (
                                    min === max
                                ) {
                                    const padding =
                                        Math.abs(
                                            min
                                        ) *
                                            0.05 ||
                                        1;

                                    min -=
                                        padding;

                                    max +=
                                        padding;
                                }

                                yMin = min;
                                yMax = max;
                            }
                        }
                    }

                    if (
                        !Number.isFinite(yMin) ||
                        !Number.isFinite(yMax) ||
                        yMax <= yMin
                    ) {
                        return;
                    }

                    const timeStart =
                        bounds.start;

                    const timeEnd =
                        bounds.end;

                    const timeRange =
                        timeEnd -
                        timeStart;

                    const valueRange =
                        yMax -
                        yMin;

                    /*
                     * Get the real telemetry samples.
                     */
                    const allSamples =
                        getOrderedSamples();

                    /*
                     * Only draw samples in the active time window.
                     */
                    const visible =
                        [];

                    for (
                        let i = 0;
                        i <
                        allSamples.length;
                        i += 1
                    ) {
                        const sample =
                            allSamples[i];

                        if (
                            sample.timestamp >=
                                timeStart &&
                            sample.timestamp <=
                                timeEnd
                        ) {
                            visible.push(
                                sample
                            );
                        }
                    }

                    if (
                        visible.length < 2
                    ) {
                        return;
                    }

                    /*
                     * ----------------------------------------------------
                     * Optional rendering decimation
                     * ----------------------------------------------------
                     *
                     * Only activate this if the telemetry provider is
                     * delivering far more samples than the canvas can
                     * physically display.
                     *
                     * This is deliberately NOT min/max decimation.
                     * We simply choose actual samples at regular positions.
                     */
                    let drawSamples =
                        visible;

                    const renderLimit =
                        Math.max(
                            width * 4,
                            2000
                        );

                    if (
                        visible.length >
                        renderLimit
                    ) {
                        const reduced =
                            [];

                        const step =
                            (visible.length -
                                1) /
                            (renderLimit -
                                1);

                        for (
                            let i = 0;
                            i <
                            renderLimit;
                            i += 1
                        ) {
                            reduced.push(
                                visible[
                                    Math.round(
                                        i *
                                            step
                                    )
                                ]
                            );
                        }

                        drawSamples =
                            reduced;
                    }

                    /*
                     * ----------------------------------------------------
                     * Draw waveform
                     * ----------------------------------------------------
                     *
                     * This is deliberately boring.
                     *
                     * Timestamp -> X
                     * Value     -> Y
                     *
                     * Connect actual samples.
                     */
                    ctx.beginPath();

                    let started =
                        false;

                    for (
                        let i = 0;
                        i <
                        drawSamples.length;
                        i += 1
                    ) {
                        const sample =
                            drawSamples[i];

                        let x =
                            ((sample.timestamp -
                                timeStart) /
                                timeRange) *
                            width;

                        let normalizedY =
                            (sample.value -
                                yMin) /
                            valueRange;

                        /*
                         * Do not modify the telemetry value.
                         * Only constrain its screen position.
                         */
                        x = Math.max(
                            0,
                            Math.min(
                                width,
                                x
                            )
                        );

                        normalizedY =
                            Math.max(
                                0,
                                Math.min(
                                    1,
                                    normalizedY
                                )
                            );

                        const y =
                            height -
                            normalizedY *
                                height;

                        if (!started) {
                            ctx.moveTo(
                                x,
                                y
                            );

                            started =
                                true;
                        } else {
                            ctx.lineTo(
                                x,
                                y
                            );
                        }
                    }

                    if (!started) {
                        return;
                    }

                    /*
                     * Main line.
                     */
                    ctx.lineWidth =
                        lineWidth;

                    ctx.strokeStyle =
                        lineColor;

                    ctx.lineJoin =
                        "round";

                    ctx.lineCap =
                        "round";

                    ctx.stroke();

                    /*
                     * Very subtle glow.
                     */
                    ctx.save();

                    ctx.globalCompositeOperation =
                        "lighter";

                    ctx.globalAlpha =
                        0.045;

                    ctx.lineWidth =
                        lineWidth * 3;

                    ctx.strokeStyle =
                        lineColor;

                    ctx.stroke();

                    ctx.restore();
                }

                /*
                 * --------------------------------------------------------
                 * View lifecycle
                 * --------------------------------------------------------
                 */

                return {
                    show(el) {
                        destroyed = false;

                        /*
                         * TimeContext for this view.
                         */
                        timeContext =
                            openmct.time.getContextForView(
                                objectPath
                            );

                        if (!timeContext) {
                            throw new Error(
                                "Astonishing Sparkline: unable to obtain Open MCT TimeContext."
                            );
                        }

                        updateMetadata();

                        if (!rangeMetadata) {
                            throw new Error(
                                `Astonishing Sparkline requires a telemetry value with a "range" hint for ${domainObject.name}.`
                            );
                        }

                        /*
                         * ------------------------------------------------
                         * DOM
                         * ------------------------------------------------
                         */

                        containerEl =
                            document.createElement(
                                "div"
                            );

                        containerEl.className =
                            "astonishing-sparkline-container";

                        const header =
                            document.createElement(
                                "div"
                            );

                        header.className =
                            "astonishing-sparkline-header";

                        header.textContent =
                            options.title ||
                            "Astonishing Sparkline";

                        containerEl.appendChild(
                            header
                        );

                        canvas =
                            document.createElement(
                                "canvas"
                            );

                        canvas.className =
                            "astonishing-sparkline-canvas";

                        containerEl.appendChild(
                            canvas
                        );

                        el.appendChild(
                            containerEl
                        );

                        ctx =
                            canvas.getContext(
                                "2d"
                            );

                        if (!ctx) {
                            throw new Error(
                                "Astonishing Sparkline: unable to create canvas."
                            );
                        }

                        /*
                         * ------------------------------------------------
                         * Resize
                         * ------------------------------------------------
                         */

                        if (
                            typeof ResizeObserver !==
                            "undefined"
                        ) {
                            resizeObserver =
                                new ResizeObserver(
                                    resizeCanvas
                                );

                            resizeObserver.observe(
                                canvas
                            );
                        } else {
                            window.addEventListener(
                                "resize",
                                resizeCanvas
                            );
                        }

                        resizeCanvas();

                        /*
                         * ------------------------------------------------
                         * Realtime subscription
                         * ------------------------------------------------
                         */

                        subscribeRealtime();

                        /*
                         * ------------------------------------------------
                         * Historical request
                         * ------------------------------------------------
                         */

                        requestHistorical(true);

                        /*
                         * ------------------------------------------------
                         * Time events
                         * ------------------------------------------------
                         */

                        timeContext.on(
                            "boundsChanged",
                            boundsChanged
                        );

                        timeContext.on(
                            "timeSystemChanged",
                            resetForTimeSystem
                        );

                        requestRender();
                    },

                    destroy() {
                        if (destroyed) {
                            return;
                        }

                        destroyed = true;

                        /*
                         * Rendering.
                         */
                        if (
                            renderFrame !== null
                        ) {
                            window.cancelAnimationFrame(
                                renderFrame
                            );

                            renderFrame =
                                null;
                        }

                        /*
                         * Resize.
                         */
                        if (
                            resizeObserver
                        ) {
                            resizeObserver.disconnect();

                            resizeObserver =
                                null;
                        } else {
                            window.removeEventListener(
                                "resize",
                                resizeCanvas
                            );
                        }

                        /*
                         * Time.
                         */
                        if (timeContext) {
                            timeContext.off(
                                "boundsChanged",
                                boundsChanged
                            );

                            timeContext.off(
                                "timeSystemChanged",
                                resetForTimeSystem
                            );
                        }

                        /*
                         * Realtime.
                         */
                        if (
                            typeof unsubscribe ===
                            "function"
                        ) {
                            unsubscribe();

                            unsubscribe =
                                null;
                        }

                        /*
                         * Invalidate outstanding historical requests.
                         */
                        requestSerial += 1;

                        requestInProgress =
                            false;

                        /*
                         * Data.
                         */
                        samplesByTime.clear();

                        loadedStart =
                            null;

                        loadedEnd =
                            null;

                        /*
                         * DOM.
                         */
                        if (
                            containerEl &&
                            containerEl.parentNode
                        ) {
                            containerEl.parentNode.removeChild(
                                containerEl
                            );
                        }

                        containerEl =
                            null;

                        canvas =
                            null;

                        ctx =
                            null;

                        /*
                         * Metadata.
                         */
                        timeContext =
                            null;

                        metadata =
                            null;

                        formatMap =
                            null;

                        rangeMetadata =
                            null;

                        timeMetadata =
                            null;

                        yMin =
                            null;

                        yMax =
                            null;
                    }
                };
            }
        });
    };
}
