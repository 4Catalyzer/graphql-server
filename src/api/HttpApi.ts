import querystring from 'querystring';
import DataLoader from 'dataloader';
import {
  Connection,
  connectionFromArray,
  forwardConnectionArgs,
} from 'graphql-relay';
import invariant from 'invariant';
import chunk from 'lodash/chunk';
import flatten from 'lodash/flatten';
import omit from 'lodash/omit';
import pick from 'lodash/pick';

import urlJoin from '../utils/urlJoin';
import { HttpMethod } from './fetch';

export type Maybe<T> = T | null | undefined;

const PAGINATION_ARG_KEYS = Object.keys(forwardConnectionArgs);

export type Args = { [key: string]: unknown };
export type Data = unknown | null | undefined;

export type QueryString = {
  parse(query: string): Record<string, string | string[]>;
  stringify(obj: Record<string, any>): string;
};

export type PaginationResult<T> = Connection<T> & {
  meta: {};
};

export type PaginatedApiResult<T> = Array<T> & {
  meta: {
    cursors?: any;
    hasNextPage?: boolean;
  };
};
export type HttpApiOptions = {
  apiBase: string;
  origin: string;
  externalOrigin: string;
};

export default abstract class HttpApi {
  _origin: string;

  _apiBase: string;

  _externalOrigin: string;

  _loader: DataLoader<string, any>;

  qs: QueryString = querystring;

  numKeysPerChunk = 25;

  constructor({ apiBase, origin, externalOrigin }: HttpApiOptions) {
    this._origin = origin;
    this._externalOrigin = externalOrigin;
    this._apiBase = apiBase;

    this._loader = new DataLoader(paths =>
      Promise.all(
        // Don't fail the entire batch on a single failed request.
        paths.map(path =>
          this.request('GET', this._getUrl(path)).catch(e => e),
        ),
      ),
    );
  }

  get<T>(path: string, args?: Args): Promise<T | null | undefined> {
    return this._loader.load(this.makePath(path, args));
  }

  async getPaginatedConnection<T>(
    path: string,
    { after, first, ...args }: Args,
  ): Promise<Maybe<PaginationResult<T>>> {
    const items = await this.get<PaginatedApiResult<T>>(
      this.makePath(path, {
        ...args,
        cursor: after,
        limit: first,
        pageSize: first,
      }),
    );

    if (!items) {
      return null;
    }

    invariant(
      items.meta,
      'Unexpected format. `GET` should return an array of items with a ' +
        '`meta` property containing an array of cursors and `hasNextPage`',
    );

    const { cursors, hasNextPage, ...meta } = items.meta!;
    const lastIndex = items.length - 1;

    // These connections only paginate forward, so the existence of a previous
    // page doesn't make any difference, but this is the correct value.
    const hasPreviousPage = !!after;
    return {
      edges: items.map((item, i) => ({
        node: item,
        cursor: cursors[i],
      })),
      pageInfo: {
        startCursor: items[0] ? cursors[0] : null,
        endCursor: items[lastIndex] ? cursors[lastIndex] : null,
        hasPreviousPage,
        hasNextPage,
      },
      meta,
    };
  }

  async getUnpaginatedConnection<T>(
    path: string,
    args: Args,
  ): Promise<Maybe<PaginationResult<T>>> {
    const apiArgs = omit(args, PAGINATION_ARG_KEYS);
    const paginationArgs = pick(args, PAGINATION_ARG_KEYS);

    // XXX Need to cast the result of the get to a list
    const items = await this.get<T[]>(this.makePath(path, apiArgs));
    invariant(
      Array.isArray(items),
      `Expected \`GET\` to return an array of items, got: ${typeof items} instead`,
    );

    return {
      ...connectionFromArray(items!, paginationArgs),
      meta: {},
    };
  }

  abstract async request<T = any>(
    _method: HttpMethod,
    _reqUrl: string,
    _data?: Data,
  ): Promise<Maybe<T>>;

  post<T>(path: string, data?: Data) {
    return this.request<T>('POST', this._getUrl(path), data);
  }

  put<T>(path: string, data?: Data) {
    return this.request<T>('PUT', this._getUrl(path), data);
  }

  patch<T>(path: string, data?: Data) {
    return this.request<T>('PATCH', this._getUrl(path), data);
  }

  delete<T>(path: string) {
    return this.request<T>('DELETE', this._getUrl(path));
  }

  makePath(path: string, args?: Args): string {
    if (!args) {
      return path;
    }

    const [pathBase, searchBase] = path.split('?');

    // TODO: Is this needed can we just insist queries are passed in as objects?
    const query = searchBase ? this.qs.parse(searchBase) : null;
    const search = this.qs.stringify({ ...query, ...args });

    if (!search) {
      return pathBase;
    }

    return `${pathBase}?${search}`;
  }

  createArgLoader<T extends Record<string, unknown>>(
    path: string,
    key: string,
  ) {
    return this.createLoader<T>(
      keys => this.getUrl(path, { [key]: keys }),
      item => item[key] as string,
    );
  }

  createLoader<T extends Record<string, unknown>>(
    getPath: (keys: string[]) => string,
    getKey: (obj: T) => string,
  ) {
    return new DataLoader<any, any>(async keys => {
      // No need to cache the GET; the DataLoader will cache it.
      const chunkedItems = await Promise.all(
        chunk<string>(keys, this.numKeysPerChunk).map(chunkKeys =>
          this.request<T[]>('GET', getPath(chunkKeys)),
        ),
      );

      const items = flatten<T | null | undefined>(chunkedItems).filter(
        <T>(item: T): item is T extends null | undefined ? never : T => !!item,
      );

      const itemsByKey: Record<string, T[]> = {};
      keys.forEach(key => {
        itemsByKey[key] = [];
      });
      items.forEach(item => {
        const key = getKey(item);
        if (itemsByKey[key]) {
          itemsByKey[key].push(item);
        }
      });

      return keys.map(key => itemsByKey[key]);
    });
  }

  getUrl(path: string, args?: Args): string {
    return this._getUrl(this.makePath(path, args));
  }

  getExternalUrl(path: string, args?: Args): string {
    return this._getUrl(this.makePath(path, args), this._externalOrigin);
  }

  _getUrl(path: string, origin: string = this._origin) {
    return `${origin}${urlJoin(this._apiBase, path)}`;
  }
}