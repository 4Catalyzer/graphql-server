import { GraphQLFieldConfig, GraphQLFieldResolver } from 'graphql';

import NodeType from './NodeType';

export default function createResolve<TSource, TContext = any>(
  resolve: GraphQLFieldResolver<TSource, TContext>,
  ensureFields: (keyof TSource)[],
): GraphQLFieldConfig<TSource, TContext>['resolve'] {
  return async (obj, args, context, info) => {
    const nodeType = info.parentType as NodeType<any, TSource>;
    for (const fieldName of ensureFields) {
      if (obj[fieldName] === undefined) {
        // await in a loop is OK here. dataloader makes sure that only
        // one request is fired
        // eslint-disable-next-line no-await-in-loop
        const fullObj = await nodeType.getNodeObject(obj, context);
        return fullObj && resolve(fullObj, args, context, info);
      }
    }

    return resolve(obj, args, context, info);
  };
}
