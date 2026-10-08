// Astonishing Sparkline plugin for Open MCT
//
// Generic telemetry sparkline for Open MCT.
//
// Numeric telemetry:
//   - Continuous line
//   - Actual telemetry samples
//   - Stable metadata-driven Y range
//
// Enum/state telemetry:
//   - Step plot
//   - No diagonal interpolation between states
//   - State labels when available
//
// Other unsupported formats:
//   - Graceful "not plottable" message
//
// Telemetry:
//   - Historical: openmct.telemetry.request()
//   - Realtime:   openmct.telemetry.subscribe()
//
// IMPORTANT:
// This view does NOT use the "minmax" strategy.
// A min/max reduction is inappropriate for a generic sparkline because
// it changes the semantic sequence of the original telemetry samples.

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

    const stateColor =
        options.stateColor || lineColor;

    const textColor =
        options.textColor || "#cccccc";

    const gridColor =
        options.gridColor ||
        "rgba(255,255,255,0.08)";

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

                    white-space: nowrap;
                    overflow: hidden;
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

                /*
                 * A range value is the normal Open MCT signal value.
                 */
                const range =
                    metadata.valuesForHints([
                        "range"
                    ])[0];

                if (!range) {
                    return false;
                }

                /*
                 * Numeric and enum values are supported.
                 *
                 * We intentionally do not claim that arbitrary strings,
                 * objects, arrays, images, etc. are sparkline data.
                 */
                const format =
                    range.format || "number";

                return (
                    format === "number" ||
                    format === "enum" ||
                    format === "float" ||
                    format === "integer" ||
                    format === "double"
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
                 * Open MCT state
                 * --------------------------------------------------------
                 */

                let timeContext = null;

                /*
                 * --------------------------------------------------------
                 * Telemetry metadata
                 * --------------------------------------------------------
                 */

                let metadata = null;
                let formatMap = null;

                let rangeMetadata = null;
                let timeMetadata = null;

                let rangeFormatter = null;
                let timeFormatter = null;

                /*
                 * --------------------------------------------------------
                 * Telemetry mode
                 * --------------------------------------------------------
                 */

                let mode = "numeric";

                /*
                 * --------------------------------------------------------
                 * Realtime subscription
                 * --------------------------------------------------------
                 */

                let unsubscribe = null;

                /*
                 * --------------------------------------------------------
                 * Historical request
                 * --------------------------------------------------------
                 */

                let requestSerial = 0;
                let requestInProgress = false;

                /*
                 * --------------------------------------------------------
                 * Samples
                 * --------------------------------------------------------
                 *
                 * timestamp -> {
                 *     timestamp,
                 *     value,
                 *     rawValue
                 * }
                 *
                 * Using timestamp as the key prevents duplicate points
                 * when historical and realtime data overlap.
                 */

                const samples =
                    new Map();

                let loadedStart = null;
                let loadedEnd = null;

                /*
                 * --------------------------------------------------------
                 * Rendering
                 * --------------------------------------------------------
                 */

                let destroyed = false;
                let renderFrame = null;
                let resizeObserver = null;

                /*
                 * --------------------------------------------------------
                 * Numeric Y range
                 * --------------------------------------------------------
                 */

                let yMin = null;
                let yMax = null;

                /*
                 * --------------------------------------------------------
                 * Enum/state information
                 * --------------------------------------------------------
                 */

                let enumEntries = [];
                let enumByValue = new Map();

                /*
                 * --------------------------------------------------------
                 * Metadata setup
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

                    /*
                     * Determine the active time field.
                     */
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

                    /*
                     * Determine visualization type from telemetry metadata.
                     *
                     * Open MCT's enum format explicitly means this value is
                     * an enumeration/state, not a continuous measurement.
                     */
                    const format =
                        rangeMetadata.format ||
                        "number";

                    mode =
                        format === "enum"
                            ? "state"
                            : "numeric";

                    /*
                     * Numeric limits come directly from metadata.
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
                     * Build enum lookup table.
                     */
                    if (
                        mode === "state" &&
                        Array.isArray(
                            rangeMetadata.enumerations
                        )
                    ) {
                        enumEntries =
                            rangeMetadata.enumerations
                                .map(
                                    (entry) => ({
                                        value:
                                            entry.value,
                                        label:
                                            String(
                                                entry.string ??
                                                entry.value
                                            )
                                    })
                                )
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
                 * --------------------------------------------------------
                 * Formatter helpers
                 * --------------------------------------------------------
                 */

                function parseTimestamp(
                    datum
                ) {
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

                function parseValue(
                    datum
                ) {
                    if (!rangeFormatter) {
                        return null;
                    }

                    try {
                        let value =
                            rangeFormatter.parse(
                                datum
                            );

                        /*
                         * Numeric arrays are not a single sparkline.
                         * Do not silently turn an array into an arbitrary
                         * first-element signal.
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
                 * --------------------------------------------------------
                 * Add datum
                 * --------------------------------------------------------
                 */

                function addDatum(datum) {
                    const timestamp =
                        parseTimestamp(
                            datum
                        );

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
                        /*
                         * Enum values are normally numeric, but we preserve
                         * their native value instead of forcing arithmetic
                         * interpretation.
                         */
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
                            value,
                            rawValue: value
                        }
                    );

                    return true;
                }

                /*
                 * --------------------------------------------------------
                 * Ordered samples
                 * --------------------------------------------------------
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
                 * --------------------------------------------------------
                 * Buffer pruning
                 * --------------------------------------------------------
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

                    /*
                     * Keep a generous amount of history so that normal
                     * scrolling does not cause constant re-fetching.
                     */
                    const keepFrom =
                        start -
                        span * 2;

                    const timestamps =
                        Array.from(
                            samples.keys()
                        ).sort(
                            (a, b) => a - b
                        );

                    /*
                     * Remove data older than our useful cache.
                     */
                    timestamps.forEach(
                        (timestamp) => {
                            if (
                                timestamp <
                                keepFrom
                            ) {
                                samples.delete(
                                    timestamp
                                );
                            }
                        }
                    );

                    /*
                     * Hard memory ceiling.
                     */
                    if (
                        samples.size <=
                        maxSamples
                    ) {
                        return;
                    }

                    const remaining =
                        Array.from(
                            samples.keys()
                        ).sort(
                            (a, b) => a - b
                        );

                    const removeCount =
                        remaining.length -
                        maxSamples;

                    for (
                        let i = 0;
                        i < removeCount;
                        i += 1
                    ) {
                        samples.delete(
                            remaining[i]
                        );
                    }
                }

                /*
                 * --------------------------------------------------------
                 * Check cached historical coverage
                 * --------------------------------------------------------
                 */

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
                 * --------------------------------------------------------
                 * Historical telemetry
                 * --------------------------------------------------------
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

                    if (
                        requestInProgress
                    ) {
                        return;
                    }

                    const timeSystem =
                        timeContext.getTimeSystem();

                    if (
                        !timeSystem ||
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
                         * Plain telemetry request.
                         *
                         * No minmax.
                         * No artificial resolution.
                         * No extrema replacement.
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

                        if (
                            destroyed ||
                            serial !==
                                requestSerial
                        ) {
                            return;
                        }

                        if (
                            Array.isArray(
                                result
                            )
                        ) {
                            result.forEach(
                                addDatum
                            );
                        }

                        loadedStart =
                            loadedStart ===
                                null
                                ? start
                                : Math.min(
                                      loadedStart,
                                      start
                                  );

                        loadedEnd =
                            loadedEnd ===
                                null
                                ? end
                                : Math.max(
                                      loadedEnd,
                                      end
                                  );

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
                 * Realtime
                 * --------------------------------------------------------
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

                                    if (
                                        bounds
                                    ) {
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
                 * --------------------------------------------------------
                 * Numeric Y fallback
                 * --------------------------------------------------------
                 */

                function establishNumericRange(
                    visibleSamples
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

                    if (
                        !visibleSamples.length
                    ) {
                        return;
                    }

                    let min =
                        Infinity;

                    let max =
                        -Infinity;

                    visibleSamples.forEach(
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
                        !Number.isFinite(min) ||
                        !Number.isFinite(max)
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
                 * --------------------------------------------------------
                 * Numeric renderer
                 * --------------------------------------------------------
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
                     * Very high sample counts cannot be represented
                     * individually by a finite-width canvas.
                     *
                     * We therefore perform simple positional sampling.
                     *
                     * This does NOT calculate min/max values and therefore
                     * cannot manufacture the sawtooth artifact from the
                     * previous implementation.
                     */
                    let points = visible;

                    const maxRenderPoints =
                        Math.max(
                            2000,
                            Math.floor(
                                width * 5
                            )
                        );

                    if (
                        points.length >
                        maxRenderPoints
                    ) {
                        const reduced =
                            [];

                        const step =
                            (points.length -
                                1) /
                            (maxRenderPoints -
                                1);

                        for (
                            let i = 0;
                            i <
                            maxRenderPoints;
                            i += 1
                        ) {
                            reduced.push(
                                points[
                                    Math.round(
                                        i *
                                            step
                                    )
                                ]
                            );
                        }

                        points =
                            reduced;
                    }

                    ctx.beginPath();

                    let started =
                        false;

                    points.forEach(
                        (sample) => {
                            let x =
                                ((sample.timestamp -
                                    start) /
                                    timeRange) *
                                width;

                            let normalized =
                                (sample.value -
                                    yMin) /
                                valueRange;

                            normalized =
                                Math.max(
                                    0,
                                    Math.min(
                                        1,
                                        normalized
                                    )
                                );

                            x =
                                Math.max(
                                    0,
                                    Math.min(
                                        width,
                                        x
                                    )
                                );

                            const y =
                                height -
                                normalized *
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
                     * Very restrained glow.
                     */
                    ctx.save();

                    ctx.globalCompositeOperation =
                        "lighter";

                    ctx.globalAlpha =
                        0.04;

                    ctx.lineWidth =
                        lineWidth * 3;

                    ctx.strokeStyle =
                        lineColor;

                    ctx.stroke();

                    ctx.restore();
                }

                /*
                 * --------------------------------------------------------
                 * State renderer
                 * --------------------------------------------------------
                 *
                 * THIS is the important distinction from the previous
                 * versions.
                 *
                 * An enum is not a continuous mathematical measurement.
                 *
                 * If the telemetry changes:
                 *
                 *     OFF -> ON
                 *
                 * we draw:
                 *
                 *     ─────────┐
                 *              │
                 *              └─────────
                 *
                 * NOT:
                 *
                 *     ───────╱
                 *           ╱
                 *         ╱
                 *
                 * and certainly not a sine wave.
                 */

                function renderState(
                    visible,
                    width,
                    height,
                    start,
                    end
                ) {
                    if (
                        !visible.length
                    ) {
                        return;
                    }

                    const timeRange =
                        end - start;

                    if (
                        timeRange <= 0
                    ) {
                        return;
                    }

                    /*
                     * Determine all states actually present.
                     */
                    const states =
                        [];

                    const seen =
                        new Map();

                    visible.forEach(
                        (sample) => {
                            const key =
                                String(
                                    sample.value
                                );

                            if (
                                !seen.has(
                                    key
                                )
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

                    /*
                     * Keep declared enum ordering where possible.
                     */
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

                    /*
                     * Draw a faint horizontal lane for each state.
                     */
                    ctx.save();

                    ctx.font =
                        "11px sans-serif";

                    ctx.textBaseline =
                        "middle";

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

                            /*
                             * State label.
                             */
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

                                started =
                                    true;
                            } else {
                                /*
                                 * Horizontal segment followed by vertical
                                 * transition.
                                 */
                                ctx.lineTo(
                                    x,
                                    previousY
                                );

                                ctx.lineTo(
                                    x,
                                    y
                                );
                            }

                            previousY =
                                y;
                        }
                    );

                    if (started) {
                        /*
                         * Continue the final state to the right edge.
                         */
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
                 * --------------------------------------------------------
                 * Main render
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

                    /*
                     * Background.
                     */
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

                    /*
                     * Current Open MCT time window.
                     */
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
                     * Only display telemetry actually belonging to this
                     * time window.
                     */
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

                    if (
                        !visible.length
                    ) {
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
                 * --------------------------------------------------------
                 * Render scheduling
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
                 * Resize
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
                 * Time changes
                 * --------------------------------------------------------
                 */

                function boundsChanged() {
                    if (destroyed) {
                        return;
                    }

                    /*
                     * Historical data is requested only if the new
                     * time window isn't already cached.
                     */
                    loadHistory(false);

                    requestRender();
                }

                function timeSystemChanged() {
                    if (destroyed) {
                        return;
                    }

                    /*
                     * A different time system means our timestamp formatter
                     * can be different.
                     */
                    samples.clear();

                    loadedStart = null;
                    loadedEnd = null;

                    requestSerial += 1;

                    updateMetadata();

                    subscribe();

                    loadHistory(true);

                    requestRender();
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
                         * TimeContext is per-view.
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
                         * ------------------------------------------------
                         * Resize observer
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
                         * Realtime telemetry
                         * ------------------------------------------------
                         */

                        subscribe();

                        /*
                         * ------------------------------------------------
                         * Historical telemetry
                         * ------------------------------------------------
                         */

                        loadHistory(true);

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
                            timeSystemChanged
                        );

                        requestRender();
                    },

                    destroy() {
                        if (destroyed) {
                            return;
                        }

                        destroyed = true;

                        /*
                         * Cancel render.
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
                                timeSystemChanged
                            );
                        }

                        /*
                         * Realtime subscription.
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
                         * Invalidate outstanding request.
                         */
                        requestSerial += 1;
                        requestInProgress =
                            false;

                        /*
                         * Samples.
                         */
                        samples.clear();

                        loadedStart = null;
                        loadedEnd = null;

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

                        containerEl = null;
                        canvas = null;
                        ctx = null;

                        /*
                         * State.
                         */
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
