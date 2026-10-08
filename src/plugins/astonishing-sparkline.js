// Astonishing Sparkline plugin for Open MCT
//
// Generic telemetry sparkline for Open MCT.
//
// Numeric telemetry:
//   - Continuous line
//   - Preserves the complete time span
//   - Rendering decimation happens ONLY at draw time
//
// Enum/state telemetry:
//   - Step plot
//   - No diagonal interpolation between states
//
// Telemetry:
//   - Historical: openmct.telemetry.request()
//   - Realtime:   openmct.telemetry.subscribe()
//
// IMPORTANT:
//   The telemetry cache is NOT limited by sample count.
//   High-frequency telemetry such as sine generators can produce thousands
//   of samples during a long time window. Removing old samples here causes
//   the trace to occupy only part of the X axis.
//
//   Instead, all samples are retained for the useful time window and the
//   renderer reduces the number of points only when necessary.

export default function astonishingSparkline(options = {}) {
    const cachePadding =
        Number.isFinite(Number(options.cachePadding))
            ? Math.max(0, Number(options.cachePadding))
            : 0.25;

    const bgColor =
        options.bgColor || "#07131a";

    const lineColor =
        options.lineColor || "#00e0a3";

    const lineWidth =
        Number(options.lineWidth) > 0
            ? Number(options.lineWidth)
            : 2;

    const stateColor =
        options.stateColor || lineColor;

    const textColor =
        options.textColor || "#cccccc";

    const gridColor =
        options.gridColor ||
        "rgba(255,255,255,0.08)";

    /*
     * Maximum number of points actually DRAWN.
     *
     * This is deliberately NOT a telemetry-cache limit.
     *
     * A canvas cannot visually benefit from hundreds of thousands of
     * individual line segments when it is only ~1000 pixels wide.
     */
    const maxRenderPoints =
        Math.max(
            2000,
            Number(options.maxRenderPoints) || 6000
        );

    return function install(openmct) {
        /*
         * ------------------------------------------------------------
         * Styles
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
                    min-width: 0;
                    max-width: none;

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
                    min-width: 0;

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

                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .astonishing-sparkline-canvas {
                    display: block;

                    width: 100%;
                    min-width: 0;
                    max-width: none;

                    height: calc(100% - 22px);

                    margin: 0;
                    padding: 0;

                    box-sizing: border-box;
                }
            `;

            document.head.appendChild(style);
        }

        /*
         * ------------------------------------------------------------
         * Object view
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

                const range =
                    metadata.valuesForHints([
                        "range"
                    ])[0];

                if (!range) {
                    return false;
                }

                const format =
                    range.format || "number";

                return (
                    format === "number" ||
                    format === "float" ||
                    format === "double" ||
                    format === "integer" ||
                    format === "enum"
                );
            },

            view(domainObject, objectPath) {
                let containerEl = null;
                let canvas = null;
                let ctx = null;

                let timeContext = null;

                let metadata = null;
                let formatMap = null;

                let rangeMetadata = null;
                let timeMetadata = null;

                let rangeFormatter = null;
                let timeFormatter = null;

                let mode = "numeric";

                let unsubscribe = null;

                /*
                 * Each historical request gets its own serial.
                 *
                 * If the user changes 5m -> 15m -> 30m quickly, an older
                 * request is allowed to finish but its result is ignored.
                 */
                let requestSerial = 0;

                /*
                 * IMPORTANT:
                 *
                 * This map is NOT limited to maxSamples.
                 *
                 * The timestamp is the key, which also removes duplicate
                 * samples when historical and realtime data overlap.
                 */
                const samples = new Map();

                let loadedStart = null;
                let loadedEnd = null;

                let destroyed = false;
                let renderFrame = null;
                let resizeObserver = null;

                let yMin = null;
                let yMax = null;

                let enumEntries = [];
                let enumByValue = new Map();

                /*
                 * ------------------------------------------------------------
                 * Metadata
                 * ------------------------------------------------------------
                 */

                function updateMetadata() {
                    metadata =
                        openmct.telemetry.getMetadata(
                            domainObject
                        );

                    formatMap = null;
                    rangeMetadata = null;
                    timeMetadata = null;

                    rangeFormatter = null;
                    timeFormatter = null;

                    enumEntries = [];
                    enumByValue.clear();

                    yMin = null;
                    yMax = null;

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

                    if (timeContext) {
                        const timeSystem =
                            timeContext.getTimeSystem();

                        if (
                            timeSystem &&
                            typeof metadata.value ===
                                "function"
                        ) {
                            timeMetadata =
                                metadata.value(
                                    timeSystem.key
                                ) || null;
                        }
                    }

                    if (formatMap) {
                        rangeFormatter =
                            formatMap[
                                rangeMetadata.key
                            ] || null;

                        if (timeMetadata) {
                            timeFormatter =
                                formatMap[
                                    timeMetadata.key
                                ] || null;
                        }
                    }

                    const format =
                        rangeMetadata.format ||
                        "number";

                    mode =
                        format === "enum"
                            ? "state"
                            : "numeric";

                    /*
                     * Use telemetry metadata limits when available.
                     *
                     * This is especially important for a sine generator:
                     * its amplitude remains stable when the time window
                     * changes.
                     */
                    if (
                        mode === "numeric"
                    ) {
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

                    /*
                     * State enumeration.
                     */
                    if (
                        mode === "state" &&
                        Array.isArray(
                            rangeMetadata.enumerations
                        )
                    ) {
                        enumEntries =
                            rangeMetadata.enumerations
                                .map((entry) => ({
                                    value:
                                        entry.value,
                                    label:
                                        String(
                                            entry.string ??
                                            entry.value
                                        )
                                }))
                                .sort(
                                    (a, b) =>
                                        Number(
                                            a.value
                                        ) -
                                        Number(
                                            b.value
                                        )
                                );

                        enumEntries.forEach(
                            (entry) => {
                                enumByValue.set(
                                    String(
                                        entry.value
                                    ),
                                    entry
                                );
                            }
                        );
                    }
                }

                /*
                 * ------------------------------------------------------------
                 * Formatters
                 * ------------------------------------------------------------
                 */

                function parseTimestamp(datum) {
                    if (!timeFormatter) {
                        return null;
                    }

                    try {
                        const value =
                            timeFormatter.parse(
                                datum
                            );

                        return Number.isFinite(
                            value
                        )
                            ? value
                            : null;
                    } catch {
                        return null;
                    }
                }

                function parseValue(datum) {
                    if (!rangeFormatter) {
                        return null;
                    }

                    try {
                        const value =
                            rangeFormatter.parse(
                                datum
                            );

                        /*
                         * A sparkline represents one scalar telemetry
                         * series. Do not silently turn an array into a
                         * completely unrelated first-element signal.
                         */
                        if (
                            Array.isArray(value)
                        ) {
                            return null;
                        }

                        return value;
                    } catch {
                        return null;
                    }
                }

                /*
                 * ------------------------------------------------------------
                 * Add telemetry
                 * ------------------------------------------------------------
                 */

                function addDatum(datum) {
                    const timestamp =
                        parseTimestamp(datum);

                    if (
                        timestamp === null
                    ) {
                        return false;
                    }

                    const value =
                        parseValue(datum);

                    if (
                        value === null ||
                        value === undefined
                    ) {
                        return false;
                    }

                    if (
                        mode === "numeric"
                    ) {
                        if (
                            typeof value !==
                                "number" ||
                            !Number.isFinite(
                                value
                            )
                        ) {
                            return false;
                        }
                    }

                    if (
                        mode === "state"
                    ) {
                        if (
                            typeof value !==
                                "number" &&
                            typeof value !==
                                "string"
                        ) {
                            return false;
                        }
                    }

                    samples.set(
                        timestamp,
                        {
                            timestamp,
                            value
                        }
                    );

                    return true;
                }

                /*
                 * ------------------------------------------------------------
                 * Ordered samples
                 * ------------------------------------------------------------
                 */

                function getOrderedSamples() {
                    const result =
                        Array.from(
                            samples.values()
                        );

                    result.sort(
                        (a, b) =>
                            a.timestamp -
                            b.timestamp
                    );

                    return result;
                }

                /*
                 * ------------------------------------------------------------
                 * Cache management
                 * ------------------------------------------------------------
                 *
                 * THIS is the important change.
                 *
                 * We no longer say:
                 *
                 *     "keep only 10,000 samples"
                 *
                 * because that destroys the left side of a high-frequency
                 * sine wave when the time window becomes longer.
                 *
                 * Instead we retain a time-based window.
                 */

                function pruneSamples(
                    start,
                    end
                ) {
                    const span =
                        Math.max(
                            1,
                            end - start
                        );

                    const keepFrom =
                        start -
                        span * cachePadding;

                    const keepUntil =
                        end +
                        span * cachePadding;

                    samples.forEach(
                        (sample, timestamp) => {
                            if (
                                timestamp <
                                    keepFrom ||
                                timestamp >
                                    keepUntil
                            ) {
                                samples.delete(
                                    timestamp
                                );
                            }
                        }
                    );
                }

                function hasCoverage(
                    start,
                    end
                ) {
                    return (
                        loadedStart !== null &&
                        loadedEnd !== null &&
                        start >= loadedStart &&
                        end <= loadedEnd
                    );
                }

                /*
                 * ------------------------------------------------------------
                 * Historical telemetry
                 * ------------------------------------------------------------
                 */

                async function loadHistory(
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

                    if (
                        !force &&
                        hasCoverage(
                            bounds.start,
                            bounds.end
                        )
                    ) {
                        requestRender();
                        return;
                    }

                    const serial =
                        ++requestSerial;

                    const start =
                        bounds.start;

                    const end =
                        bounds.end;

                    const timeSystem =
                        timeContext.getTimeSystem();

                    if (
                        !timeSystem ||
                        !timeFormatter ||
                        !rangeFormatter
                    ) {
                        return;
                    }

                    try {
                        /*
                         * IMPORTANT:
                         *
                         * Every new time window gets its own request.
                         *
                         * We do NOT block a new request merely because
                         * another request is still running.
                         */
                        const result =
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
                         * Ignore stale requests.
                         */
                        if (
                            destroyed ||
                            serial !==
                                requestSerial
                        ) {
                            return;
                        }

                        if (
                            Array.isArray(result)
                        ) {
                            result.forEach(
                                addDatum
                            );
                        }

                        /*
                         * Recalculate the known coverage from this request.
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

                        /*
                         * Keep the complete requested time span.
                         * Never reduce it to a sample-count limit.
                         */
                        pruneSamples(
                            start,
                            end
                        );

                        requestRender();
                    } catch (error) {
                        if (
                            !destroyed &&
                            serial ===
                                requestSerial
                        ) {
                            console.error(
                                "Astonishing Sparkline telemetry request failed:",
                                error
                            );
                        }
                    }
                }

                /*
                 * ------------------------------------------------------------
                 * Realtime telemetry
                 * ------------------------------------------------------------
                 */

                function subscribe() {
                    if (
                        typeof unsubscribe ===
                        "function"
                    ) {
                        unsubscribe();
                        unsubscribe = null;
                    }

                    if (
                        destroyed ||
                        !timeContext
                    ) {
                        return;
                    }

                    const timeSystem =
                        timeContext.getTimeSystem();

                    if (!timeSystem) {
                        return;
                    }

                    unsubscribe =
                        openmct.telemetry.subscribe(
                            domainObject,
                            (datum) => {
                                if (
                                    destroyed
                                ) {
                                    return;
                                }

                                if (
                                    addDatum(
                                        datum
                                    )
                                ) {
                                    const bounds =
                                        timeContext.getBounds();

                                    if (bounds) {
                                        pruneSamples(
                                            bounds.start,
                                            bounds.end
                                        );
                                    }

                                    requestRender();
                                }
                            },
                            {
                                domain:
                                    timeSystem.key
                            }
                        );
                }

                /*
                 * ------------------------------------------------------------
                 * Numeric range
                 * ------------------------------------------------------------
                 */

                function establishNumericRange(
                    visible
                ) {
                    if (
                        Number.isFinite(
                            yMin
                        ) &&
                        Number.isFinite(
                            yMax
                        )
                    ) {
                        return;
                    }

                    if (!visible.length) {
                        return;
                    }

                    let min =
                        Infinity;

                    let max =
                        -Infinity;

                    visible.forEach(
                        (sample) => {
                            min =
                                Math.min(
                                    min,
                                    sample.value
                                );

                            max =
                                Math.max(
                                    max,
                                    sample.value
                                );
                        }
                    );

                    if (
                        !Number.isFinite(
                            min
                        ) ||
                        !Number.isFinite(
                            max
                        )
                    ) {
                        return;
                    }

                    if (min === max) {
                        const padding =
                            Math.abs(min) *
                                0.05 ||
                            1;

                        min -= padding;
                        max += padding;
                    }

                    yMin = min;
                    yMax = max;
                }

                /*
                 * ------------------------------------------------------------
                 * Rendering decimation
                 * ------------------------------------------------------------
                 *
                 * This is where we reduce a huge sine-generator dataset.
                 *
                 * The ORIGINAL cache remains complete.
                 *
                 * The decimation is positional, so the first point and last
                 * point always remain represented across the entire time
                 * window.
                 */

                function decimateForRendering(
                    points
                ) {
                    if (
                        points.length <=
                        maxRenderPoints
                    ) {
                        return points;
                    }

                    const result =
                        new Array(
                            maxRenderPoints
                        );

                    const last =
                        points.length - 1;

                    const denominator =
                        maxRenderPoints - 1;

                    for (
                        let i = 0;
                        i <
                        maxRenderPoints;
                        i += 1
                    ) {
                        const index =
                            Math.round(
                                (i /
                                    denominator) *
                                    last
                            );

                        result[i] =
                            points[index];
                    }

                    return result;
                }

                /*
                 * ------------------------------------------------------------
                 * Numeric renderer
                 * ------------------------------------------------------------
                 */

                function renderNumeric(
                    visible,
                    width,
                    height,
                    start,
                    end
                ) {
                    establishNumericRange(
                        visible
                    );

                    if (
                        !Number.isFinite(
                            yMin
                        ) ||
                        !Number.isFinite(
                            yMax
                        ) ||
                        yMax <= yMin
                    ) {
                        return;
                    }

                    const timeRange =
                        end - start;

                    const valueRange =
                        yMax - yMin;

                    if (
                        timeRange <= 0 ||
                        valueRange <= 0
                    ) {
                        return;
                    }

                    /*
                     * IMPORTANT:
                     *
                     * Decimation happens only here.
                     *
                     * The full telemetry time span remains intact.
                     */
                    const points =
                        decimateForRendering(
                            visible
                        );

                    ctx.beginPath();

                    let started =
                        false;

                    points.forEach(
                        (sample) => {
                            const normalizedX =
                                (sample.timestamp -
                                    start) /
                                timeRange;

                            const normalizedY =
                                (sample.value -
                                    yMin) /
                                valueRange;

                            const x =
                                Math.max(
                                    0,
                                    Math.min(
                                        width,
                                        normalizedX *
                                            width
                                    )
                                );

                            const y =
                                height -
                                Math.max(
                                    0,
                                    Math.min(
                                        1,
                                        normalizedY
                                    )
                                ) *
                                    height;

                            if (!started) {
                                ctx.moveTo(
                                    x,
                                    y
                                );

                                started = true;
                            } else {
                                ctx.lineTo(
                                    x,
                                    y
                                );
                            }
                        }
                    );

                    if (!started) {
                        return;
                    }

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
                     * Subtle glow.
                     */
                    ctx.save();

                    ctx.globalCompositeOperation =
                        "lighter";

                    ctx.globalAlpha =
                        0.035;

                    ctx.lineWidth =
                        lineWidth * 3;

                    ctx.strokeStyle =
                        lineColor;

                    ctx.stroke();

                    ctx.restore();
                }

                /*
                 * ------------------------------------------------------------
                 * State renderer
                 * ------------------------------------------------------------
                 */

                function renderState(
                    visible,
                    width,
                    height,
                    start,
                    end
                ) {
                    if (!visible.length) {
                        return;
                    }

                    const timeRange =
                        end - start;

                    if (timeRange <= 0) {
                        return;
                    }

                    const states = [];
                    const seen =
                        new Map();

                    visible.forEach(
                        (sample) => {
                            const key =
                                String(
                                    sample.value
                                );

                            if (
                                !seen.has(key)
                            ) {
                                const known =
                                    enumByValue.get(
                                        key
                                    );

                                const entry =
                                    known || {
                                        value:
                                            sample.value,
                                        label:
                                            String(
                                                sample.value
                                            )
                                    };

                                seen.set(
                                    key,
                                    entry
                                );

                                states.push(
                                    entry
                                );
                            }
                        }
                    );

                    if (
                        enumEntries.length
                    ) {
                        states.sort(
                            (a, b) => {
                                const ai =
                                    enumEntries.findIndex(
                                        (entry) =>
                                            String(
                                                entry.value
                                            ) ===
                                            String(
                                                a.value
                                            )
                                    );

                                const bi =
                                    enumEntries.findIndex(
                                        (entry) =>
                                            String(
                                                entry.value
                                            ) ===
                                            String(
                                                b.value
                                            )
                                    );

                                return (
                                    (ai < 0
                                        ? 999999
                                        : ai) -
                                    (bi < 0
                                        ? 999999
                                        : bi)
                                );
                            }
                        );
                    }

                    const stateIndex =
                        new Map();

                    states.forEach(
                        (state, index) => {
                            stateIndex.set(
                                String(
                                    state.value
                                ),
                                index
                            );
                        }
                    );

                    ctx.save();

                    ctx.font =
                        "11px sans-serif";

                    ctx.textBaseline =
                        "middle";

                    /*
                     * State lanes.
                     */
                    states.forEach(
                        (state, index) => {
                            const y =
                                states.length ===
                                1
                                    ? height / 2
                                    : (index /
                                          Math.max(
                                              1,
                                              states.length -
                                                  1
                                          )) *
                                          (height -
                                              20) +
                                      10;

                            ctx.strokeStyle =
                                gridColor;

                            ctx.lineWidth =
                                1;

                            ctx.beginPath();

                            ctx.moveTo(
                                0,
                                y
                            );

                            ctx.lineTo(
                                width,
                                y
                            );

                            ctx.stroke();

                            ctx.fillStyle =
                                textColor;

                            ctx.fillText(
                                state.label,
                                4,
                                y
                            );
                        }
                    );

                    /*
                     * Step trace.
                     */
                    ctx.beginPath();

                    let previousY =
                        null;

                    let started =
                        false;

                    visible.forEach(
                        (sample) => {
                            const index =
                                stateIndex.get(
                                    String(
                                        sample.value
                                    )
                                );

                            if (
                                index ===
                                undefined
                            ) {
                                return;
                            }

                            const x =
                                Math.max(
                                    0,
                                    Math.min(
                                        width,
                                        ((sample.timestamp -
                                            start) /
                                            timeRange) *
                                            width
                                    )
                                );

                            const y =
                                states.length ===
                                1
                                    ? height / 2
                                    : (index /
                                          Math.max(
                                              1,
                                              states.length -
                                                  1
                                          )) *
                                          (height -
                                              20) +
                                      10;

                            if (!started) {
                                ctx.moveTo(
                                    x,
                                    y
                                );

                                started = true;
                            } else {
                                ctx.lineTo(
                                    x,
                                    previousY
                                );

                                ctx.lineTo(
                                    x,
                                    y
                                );
                            }

                            previousY = y;
                        }
                    );

                    if (started) {
                        ctx.lineTo(
                            width,
                            previousY
                        );

                        ctx.lineWidth =
                            lineWidth;

                        ctx.strokeStyle =
                            stateColor;

                        ctx.lineJoin =
                            "round";

                        ctx.lineCap =
                            "round";

                        ctx.stroke();
                    }

                    ctx.restore();
                }

                /*
                 * ------------------------------------------------------------
                 * Main render
                 * ------------------------------------------------------------
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

                    const ordered =
                        getOrderedSamples();

                    const visible =
                        ordered.filter(
                            (sample) =>
                                sample.timestamp >=
                                    bounds.start &&
                                sample.timestamp <=
                                    bounds.end
                        );

                    if (!visible.length) {
                        return;
                    }

                    if (
                        mode === "state"
                    ) {
                        renderState(
                            visible,
                            width,
                            height,
                            bounds.start,
                            bounds.end
                        );
                    } else {
                        renderNumeric(
                            visible,
                            width,
                            height,
                            bounds.start,
                            bounds.end
                        );
                    }
                }

                /*
                 * ------------------------------------------------------------
                 * Render scheduling
                 * ------------------------------------------------------------
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
                 * ------------------------------------------------------------
                 * Resize
                 * ------------------------------------------------------------
                 *
                 * The CSS determines the displayed width.
                 * JavaScript only synchronizes the canvas backing store.
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

                    const pixelWidth =
                        Math.max(
                            2,
                            Math.round(
                                width * dpr
                            )
                        );

                    const pixelHeight =
                        Math.max(
                            2,
                            Math.round(
                                height * dpr
                            )
                        );

                    /*
                     * Do not repeatedly reset the canvas if its dimensions
                     * have not changed.
                     */
                    if (
                        canvas.width !==
                            pixelWidth ||
                        canvas.height !==
                            pixelHeight
                    ) {
                        canvas.width =
                            pixelWidth;

                        canvas.height =
                            pixelHeight;
                    }

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
                 * ------------------------------------------------------------
                 * Time bounds changed
                 * ------------------------------------------------------------
                 */

                function boundsChanged() {
                    if (destroyed) {
                        return;
                    }

                    /*
                     * Reset the cached coverage when the requested window
                     * changes substantially. This guarantees that a 30-minute
                     * sine window gets its complete historical dataset rather
                     * than depending on whatever happened to be loaded first.
                     */
                    const bounds =
                        timeContext.getBounds();

                    if (bounds) {
                        const currentSpan =
                            bounds.end -
                            bounds.start;

                        const currentCoverage =
                            loadedStart !== null &&
                            loadedEnd !== null;

                        const contains =
                            currentCoverage &&
                            bounds.start >=
                                loadedStart &&
                            bounds.end <=
                                loadedEnd;

                        if (!contains) {
                            /*
                             * We keep existing samples because they may overlap
                             * the new request. The new request fills the missing
                             * time span.
                             */
                            loadHistory(false);
                        } else {
                            requestRender();
                        }

                        /*
                         * Keep only a time-based cache around the active window.
                         */
                        if (
                            currentSpan > 0
                        ) {
                            pruneSamples(
                                bounds.start,
                                bounds.end
                            );
                        }
                    }

                    requestRender();
                }

                /*
                 * ------------------------------------------------------------
                 * Time system changed
                 * ------------------------------------------------------------
                 */

                function timeSystemChanged() {
                    if (destroyed) {
                        return;
                    }

                    requestSerial += 1;

                    samples.clear();

                    loadedStart = null;
                    loadedEnd = null;

                    updateMetadata();

                    subscribe();

                    loadHistory(true);

                    requestRender();
                }

                /*
                 * ------------------------------------------------------------
                 * View lifecycle
                 * ------------------------------------------------------------
                 */

                return {
                    show(el) {
                        destroyed = false;

                        /*
                         * Open MCT owns the outer element.
                         *
                         * We make our contents fluid without changing
                         * Open MCT's own layout.
                         */
                        el.style.width =
                            "100%";

                        el.style.minWidth =
                            "0";

                        el.style.boxSizing =
                            "border-box";

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
                            domainObject.name ||
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
                                "Astonishing Sparkline: unable to create canvas context."
                            );
                        }

                        /*
                         * Observe the container rather than the canvas.
                         *
                         * The canvas is a child whose CSS width is already
                         * 100%. The container is the actual layout boundary.
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
                                containerEl
                            );
                        } else {
                            window.addEventListener(
                                "resize",
                                resizeCanvas
                            );
                        }

                        resizeCanvas();

                        subscribe();

                        loadHistory(true);

                        timeContext.on(
                            "boundsChanged",
                            boundsChanged
                        );

                        timeContext.on(
                            "timeSystemChanged",
                            timeSystemChanged
                        );

                        requestRender();
                    },

                    destroy() {
                        if (destroyed) {
                            return;
                        }

                        destroyed = true;

                        requestSerial += 1;

                        if (
                            renderFrame !==
                            null
                        ) {
                            window.cancelAnimationFrame(
                                renderFrame
                            );

                            renderFrame =
                                null;
                        }

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

                        if (timeContext) {
                            timeContext.off(
                                "boundsChanged",
                                boundsChanged
                            );

                            timeContext.off(
                                "timeSystemChanged",
                                timeSystemChanged
                            );
                        }

                        if (
                            typeof unsubscribe ===
                            "function"
                        ) {
                            unsubscribe();
                            unsubscribe =
                                null;
                        }

                        samples.clear();

                        loadedStart = null;
                        loadedEnd = null;

                        if (
                            containerEl &&
                            containerEl.parentNode
                        ) {
                            containerEl.parentNode.removeChild(
                                containerEl
                            );
                        }

                        containerEl = null;
                        canvas = null;
                        ctx = null;

                        timeContext = null;

                        metadata = null;
                        formatMap = null;

                        rangeMetadata = null;
                        timeMetadata = null;

                        rangeFormatter = null;
                        timeFormatter = null;

                        enumEntries = [];
                        enumByValue.clear();

                        yMin = null;
                        yMax = null;
                    }
                };
            }
        });
    };
}