const moment        = require('moment');
const MBDefaults    = require('./mb_defaults');
const Client        = require('../../base/client');
const SocketCache   = require('../../../_common/base/socket_cache');
const getLanguage   = require('../../../_common/language').get;
const localize      = require('../../../_common/localize').localize;
const padLeft       = require('../../../_common/string_util').padLeft;
const toTitleCase   = require('../../../_common/string_util').toTitleCase;
const isEmptyObject = require('../../../_common/utility').isEmptyObject;

/*
 * Contract object mocks the trading form we have on our website
 * It parses the contracts json we get from socket.send({contracts_for: 'R_50'})
 */
const MBContract = (() => {
    let contracts_for_response,
        remaining_timeout,
        current_time_left,
        $period,
        $durations,
        $duration,
        $count_down_timer;

    const hidden_class = 'invisible';

    const duration_map = {
        m: 'minute',
        h: 'h',
        d: 'day',
        W: 'week',
        M: 'month',
        Y: 'year',
    };

    const durationText = (duration, is_jp_client) => {
        let dur = duration;
        if (dur && is_jp_client) {
            dur = dur.replace(/([a-z])/, '$1<br>');
            Object.keys(duration_map).forEach((key) => {
                dur = dur.replace(key, localize(duration_map[key] + (+dur[0] === 1 || /h/.test(key) ? '' : 's')));
            });
        }
        return dur.toUpperCase();
    };

    const periodText = (trading_period, is_jp_client) => {
        let date_start,
            date_expiry,
            duration;
        if (typeof trading_period === 'object') {
            date_start  = trading_period.date_start.epoch;
            date_expiry = trading_period.date_expiry.epoch;
            duration    = trading_period.duration;
        } else {
            date_start  = trading_period.split('_')[0];
            date_expiry = trading_period.split('_')[1];
            duration    = trading_period.split('_')[2];
        }
        duration = duration ? duration.replace('0d', '1d') : '';

        const toDate = (date) => {
            let text_value = moment.utc(date * 1000)
                .utcOffset(is_jp_client ? '+09:00' : '+00:00')
                .locale(getLanguage().toLowerCase());
            if (is_jp_client) {
                text_value = text_value.format('MMM Do, HH:mm').replace(/08:59/, '09:00«');
            } else {
                text_value = text_value.format('HH:mm');
            }
            return text_value;
        };
        return {
            end     : is_jp_client ? toDate(date_expiry) : `${[toDate(date_start), toDate(date_expiry)].join('-')} GMT`,
            duration: durationText(duration, is_jp_client),
        };
    };

    const populatePeriods = (should_rebuild) => {
        if (!contracts_for_response || isEmptyObject(contracts_for_response)) return;
        let trading_period,
            start_end;
        const trading_period_array = [];
        const available_contracts  = contracts_for_response.contracts_for.available;
        const selected_option      = MBDefaults.get('category');
        $period                    = $('#period');
        if (!selected_option || !available_contracts) return;
        for (let i = 0; i < available_contracts.length; i++) {
            if (available_contracts[i].contract_category === selected_option) {
                trading_period = available_contracts[i].trading_period;
                if (!trading_period) return;
                start_end = [trading_period.date_start.epoch, trading_period.date_expiry.epoch, trading_period.duration].join('_');
                if (trading_period_array.indexOf(start_end) < 0) {
                    trading_period_array.push(start_end);
                }
            }
        }
        trading_period_array.sort(sortByExpiryTime);
        const $list = $period.find('.list');
        if (should_rebuild) {
            $list.empty();
        }
        const is_jp_client = Client.isJPClient();

        const duration_class    = 'gr-3 gr-no-gutter';
        const end_time_class    = is_jp_client ? 'gr-6 gr-5-m' : 'gr-6';
        const remain_time_class = is_jp_client ? 'gr-3 gr-4-m gr-no-gutter' : 'gr-6';
        const makeItem = (period) => {
            const text = periodText(period, is_jp_client);

            const $div_period      = $('<div/>', { value: period, class: 'gr-row' });

            const $div_end_time    = $('<div/>', { class: `end ${end_time_class}`, text: text.end });
            const $div_remain_time = $('<div/>', { class: `remaining-time ${remain_time_class}` });

            if (is_jp_client) {
                const $div_duration = $('<div/>', { class: `duration ${duration_class}`, html: text.duration });
                $div_period.append($div_duration);
            }

            $div_period.append($div_end_time).append($div_remain_time);

            return $div_period;
        };
        if ($list.children().length === 0) { // populate for the first time
            let default_value = MBDefaults.get('period');
            if (trading_period_array.indexOf(default_value) === -1) default_value = '';
            trading_period_array.forEach((period, idx) => {
                const is_current = (!default_value && idx === 0) || period === default_value;
                const $current   = makeItem(period);
                $list.append($current);
                if (is_current) {
                    setCurrentItem($period, period);
                }
            });
            MBDefaults.set('period', $period.attr('value'));
            displayRemainingTime(true, is_jp_client);
        } else { // update options
            let existing_array  = [];
            const missing_array = [];
            $list.find('> div').each(function () {
                existing_array.push($(this).val());
            });

            // add new periods to dropdown
            trading_period_array.forEach((period) => {
                if (existing_array.indexOf(period) < 0) {
                    missing_array.push(period);
                }
            });
            if (missing_array.length > 0) {
                let $new_item;
                existing_array = existing_array.concat(missing_array).sort(sortByExpiryTime);
                existing_array.forEach((existing, idx) => {
                    if ($list.find(`[value="${existing}"]`).length < 1) {
                        $new_item = makeItem(existing);
                        if (idx < 1) {
                            $($new_item).insertBefore($list.children().eq(idx));
                        } else {
                            $($new_item).insertAfter($list.children().eq(idx - 1));
                        }
                    }
                });
            }

            // remove periods that no longer exist
            existing_array.forEach((period) => {
                if (trading_period_array.indexOf(period) < 0) {
                    $list.find(`[value="${period}"]`).remove();
                }
            });
        }
    };

    const displayRemainingTime = (should_recalculate, is_jp_client) => {
        if (typeof $durations === 'undefined' || should_recalculate) {
            // period_value = MBDefaults.get('period');
            $period    = $('#period');
            $durations = $period.find('.list > div, .current > div');
        }
        if (!$durations) return;
        $durations.each((idx) => {
            $duration         = $($durations[idx]);
            $count_down_timer = $duration.find('.remaining-time');

            const time_left = parseInt($duration.attr('value').split('_')[1]) - window.time.unix();
            if (time_left <= 0) {
                // clear the expired contracts_for response
                SocketCache.remove('contracts_for', 1);
                location.reload();
            } else if (time_left < 120) {
                $count_down_timer.addClass('alert');
            }
            const remaining_month_day_string = [];
            const remaining_time_string      = [];

            const duration = moment.duration(time_left * 1000);

            const all_durations = {
                month : duration.months(),
                day   : duration.days(),
                hour  : duration.hours(),
                minute: duration.minutes(),
                second: duration.seconds(),
            };

            let duration_unit_to_show;
            Object.keys(all_durations).forEach((key) => {
                if (/month|day/.test(key)) {
                    if (all_durations[key]) {
                        if (is_jp_client) {
                            duration_unit_to_show = key[0];
                            remaining_month_day_string
                                .push(all_durations[key] + localize(toTitleCase(duration_unit_to_show)));
                        } else {
                            duration_unit_to_show = all_durations[key] === 1 ? key : `${key}s`;
                            remaining_month_day_string
                                .push(`${all_durations[key]} ${localize(toTitleCase(duration_unit_to_show))}`);
                        }
                    }
                } else {
                    remaining_time_string.push(padLeft(all_durations[key] || 0, 2, '0'));
                }
            });

            $count_down_timer.text(`${remaining_month_day_string.join(is_jp_client ? '' : ' ')} ${remaining_time_string.join(':')}`);
        });
        current_time_left = parseInt($period.attr('value').split('_')[1]) - window.time.unix();
        if (current_time_left < 120) {
            // make all price buttons inactive if less than 2 minutes remaining
            $('.price-button').addClass('inactive');
        }
        if (remaining_timeout) clearRemainingTimeout();
        remaining_timeout = setTimeout(() => { displayRemainingTime(false, is_jp_client); }, 500);
    };

    const clearRemainingTimeout = () => { clearTimeout(remaining_timeout); };

    const sortByExpiryTime = (first, second) => {
        const a = first.split('_');
        const b = second.split('_');

        const duration1 = a[1] - a[0];
        const duration2 = b[1] - b[0];

        return a[1] === b[1] ? duration1 - duration2 : a[1] - b[1];
    };

    const categories  = [
        { value: 'callput',      type1: 'PUT',          type2: 'CALLE' },
        { value: 'touchnotouch', type1: 'ONETOUCH',     type2: 'NOTOUCH' },
        { value: 'endsinout',    type1: 'EXPIRYRANGEE', type2: 'EXPIRYMISS' },
        { value: 'staysinout',   type1: 'RANGE',        type2: 'UPORDOWN' },
    ];

    const populateOptions = (should_rebuild) => {
        if (!contracts_for_response || isEmptyObject(contracts_for_response)) return;
        const available_contracts = contracts_for_response.contracts_for.available;

        const $category = $('#category');
        const $list     = $category.find('.list');
        if (should_rebuild) {
            $list.empty();
        }
        if ($list.children().length === 0) {
            const default_value = MBDefaults.get('category');
            const is_jp_client  = Client.isJPClient();
            categories.forEach((category, idx) => {
                if (available_contracts.find(contract => contract.contract_category === category.value)) {
                    const is_current = (!default_value && idx === 0) || category.value === default_value;
                    let el_contract_type;
                    if (is_jp_client) {
                        el_contract_type =
                            `<span class="contract-type gr-6 ${category.type1}"><span>${localize(getTemplate(category.type1).name)}</span></span>
                             <span class="contract-type gr-6 ${category.type2} negative-color"><span>${localize(getTemplate(category.type2).name)}</span></span>`;
                    } else {
                        el_contract_type =
                            `<div class="category-wrapper gr-6"><div class="contract-type ${category.type2}" /><div>${localize(getTemplate(category.type2).name)}</div></div>
                             <div class="category-wrapper gr-6"><div class="contract-type ${category.type1} negative-color" /><div>${localize(getTemplate(category.type1).name)}</div></div>`;
                    }
                    const $current   = $('<div/>', {
                        value: category.value,
                        html : el_contract_type,
                        class: 'gr-row',
                    });
                    $list.append($current);
                    if (is_current) {
                        setCurrentItem($category, category.value);
                    }
                }
            });
            MBDefaults.set('category', $category.attr('value'));
        }
        populatePeriods(should_rebuild);
    };

    const getCurrentContracts = () => {
        if (!contracts_for_response || isEmptyObject(contracts_for_response)) return [];
        const contracts = [];
        const periods   = MBDefaults.get('period').split('_');
        contracts_for_response.contracts_for.available.forEach((c) => {
            // only allow callput/callputequal contracts here
            if (/callput/.test(c.contract_category) && c.trading_period &&
                +c.trading_period.date_start.epoch === +periods[0] &&
                +c.trading_period.date_expiry.epoch === +periods[1]) {
                contracts.push(c);
            }
        });
        return contracts;
    };

    const getTemplate = (contract_type) => {
        const is_jp_client = Client.isJPClient();
        const templates = {
            PUT: {
                opposite   : 'CALLE',
                order      : is_jp_client ? 0 : 1,
                name       : 'Lower',
                description: '[_1] [_2] payout if [_3] is strictly lower than Barrier at close on [_4].',
            },
            CALLE: {
                opposite   : 'PUT',
                order      : is_jp_client ? 1 : 0,
                name       : 'Higher',
                description: '[_1] [_2] payout if [_3] is strictly higher than or equal to Barrier at close on [_4].',
            },
            ONETOUCH: {
                opposite   : 'NOTOUCH',
                order      : 0,
                name       : 'Touches',
                description: '[_1] [_2] payout if [_3] touches Barrier through close on [_4].',
            },
            NOTOUCH: {
                opposite   : 'ONETOUCH',
                order      : 1,
                name       : 'Does Not Touch',
                description: '[_1] [_2] payout if [_3] does not touch Barrier through close on [_4].',
            },
            EXPIRYRANGEE: {
                opposite   : 'EXPIRYMISS',
                order      : 0,
                name       : 'Ends Between',
                description: '[_1] [_2] payout if [_3] ends on or between low and high values of Barrier at close on [_4].',
            },
            EXPIRYMISS: {
                opposite   : 'EXPIRYRANGEE',
                order      : 1,
                name       : 'Ends Outside',
                description: '[_1] [_2] payout if [_3] ends outside low and high values of Barrier at close on [_4].',
            },
            RANGE: {
                opposite   : 'UPORDOWN',
                order      : 0,
                name       : 'Stays Between',
                description: '[_1] [_2] payout if [_3] stays between low and high values of Barrier through close on [_4].',
            },
            UPORDOWN: {
                opposite   : 'RANGE',
                order      : 1,
                name       : 'Goes Outside',
                description: '[_1] [_2] payout if [_3] goes outside of low and high values of Barrier through close on [_4].',
            },
        };
        return contract_type ? templates[contract_type] : templates;
    };

    const getCurrency = () => (Client.get('currency') || $('#currency').attr('value') || 'JPY');

    const setCurrentItem = ($container, value, is_underlying) => {
        const $selected = $container.find(`.list [value="${value}"]`);
        if ($selected.length) {
            if (is_underlying) {
                $container.attr('value', value).find('> .current').find('img').attr('src', $selected.find('img').attr('src'))
                    .end()
                    .find('.name')
                    .text($selected.text());
            } else {
                $container.attr('value', value).find('> .current').html($selected.clone());
            }

            $container.find(`.list .${hidden_class}`).removeClass(hidden_class);
            $selected.addClass(hidden_class);
        }
    };

    return {
        populatePeriods,
        populateOptions,
        displayRemainingTime,
        getCurrentContracts,
        getTemplate,
        getCurrency,
        setCurrentItem,
        getRemainingTime    : () => current_time_left,
        getContractsResponse: () => contracts_for_response,
        setContractsResponse: (contracts_for) => { contracts_for_response = contracts_for; },
        onUnload            : () => {
            clearRemainingTimeout(); contracts_for_response = {}; $durations = undefined;
        },
    };
})();

module.exports = MBContract;
